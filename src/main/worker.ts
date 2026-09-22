import { createServer } from "node:http";
import { getRule } from "../attribution/ruleConfig.js";
import { loadConfig } from "../config.js";
import { consumeEventsSafely } from "../consumers/eventConsumer.js";
import { consumeOneOrderEvent } from "../consumers/orderEventConsumer.js";
import { createPool } from "../db/pool.js";
import { checkInvariants, recordInvariantCheck } from "../ledger/invariants.js";
import { errorMessage } from "../lib/errors.js";
import { createLogger } from "../lib/logger.js";
import { sleep } from "../lib/sleep.js";
import { invariantOk, registry } from "../metrics.js";
import { runCommissionSweep } from "../orders/sweep.js";
import { exitOnConfigError } from "./shared.js";

const config = exitOnConfigError(loadConfig);
const logger = createLogger(config.logLevel, "worker");
const rule = getRule(config.attributionRuleVersion);
const pool = createPool(config.databaseUrl, config.worker.eventConsumers + config.worker.orderConsumers + 4, "aumbram-worker");

let running = true;

/** Runs `step` until shutdown. Backs off while idle (step returned 0/false) or failing. */
async function loop(name: string, step: () => Promise<number | boolean>): Promise<void> {
  let idle = 0;
  while (running) {
    try {
      const did = await step();
      if (did === 0 || did === false) {
        idle = Math.min(idle + 1, 5);
        await sleep(Math.min(config.worker.idlePollMs * idle, 1000));
      } else {
        idle = 0;
      }
    } catch (err) {
      logger.error({ loop: name, err: errorMessage(err) }, "consumer loop error; backing off");
      await sleep(1000);
    }
  }
}

function every(seconds: number, name: string, task: () => Promise<void>): NodeJS.Timeout | null {
  if (seconds <= 0) return null;
  const timer = setInterval(() => {
    task().catch((err: unknown) => logger.error({ task: name, err: errorMessage(err) }, "scheduled task failed"));
  }, seconds * 1000);
  timer.unref();
  return timer;
}

const loops: Promise<void>[] = [];
for (let i = 0; i < config.worker.eventConsumers; i++) {
  loops.push(loop(`events-${i}`, () => consumeEventsSafely({ pool, rule, log: logger, batchSize: config.worker.eventBatchSize })));
}
for (let i = 0; i < config.worker.orderConsumers; i++) {
  loops.push(loop(`orders-${i}`, () => consumeOneOrderEvent({ pool, rule, log: logger })));
}

const timers = [
  every(config.worker.sweepIntervalSeconds, "sweep", async () => {
    const result = await runCommissionSweep(pool, Date.now());
    logger.info(result, "scheduled commission sweep finished");
  }),
  every(config.worker.invariantCheckIntervalSeconds, "invariants", async () => {
    const report = await checkInvariants(pool);
    await recordInvariantCheck(pool, report);
    invariantOk.set(report.ok ? 1 : 0);
    if (report.ok) logger.debug(report, "ledger invariants hold");
    else logger.error({ alert: "LEDGER_INVARIANT_VIOLATION", ...report }, "ledger invariant violated");
  }),
];

const metricsServer = createServer((req, res) => {
  if (req.url === "/metrics") {
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(body);
      })
      .catch((err: unknown) => {
        res.writeHead(500);
        res.end(errorMessage(err));
      });
    return;
  }
  if (req.url === "/health") {
    res.writeHead(running ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: running ? "ok" : "stopping" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
metricsServer.listen(config.worker.metricsPort, "0.0.0.0");
logger.info(
  { eventConsumers: config.worker.eventConsumers, orderConsumers: config.worker.orderConsumers, rule: rule.version, metricsPort: config.worker.metricsPort },
  "worker started",
);

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  logger.info({ signal }, "worker shutting down; finishing in-flight batches");
  for (const t of timers) if (t) clearInterval(t);
  await Promise.all(loops);
  metricsServer.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));