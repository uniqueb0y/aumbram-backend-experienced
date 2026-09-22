/**
 * Operational commands:
 *   migrate                               apply SQL migrations
 *   seed <dir>                            load creators/products/stories from generator output
 *   sweep [--as-of <iso>]                 run the commission sweep
 *   check-invariants                      verify ledger invariants (exit 2 on violation)
 *   backfill-events --file <csv>          historical import trusting server_ts
 *   reattribute --from <iso> --to <iso>   re-run attribution for orders created in a range
 */
import { resolve } from "node:path";
import { getRule } from "../attribution/ruleConfig.js";
import { createPool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { checkInvariants, recordInvariantCheck } from "../ledger/invariants.js";
import { parseIsoTimestamp } from "../lib/time.js";
import { runCommissionSweep } from "../orders/sweep.js";
import { backfillEventsCsv } from "../tools/backfill.js";
import { reattributeRange } from "../tools/reattribute.js";
import { seedReferenceData } from "../tools/seed.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireTimestamp(args: string[], name: string): number {
  const ms = parseIsoTimestamp(flag(args, name));
  if (ms === null) throw new Error(`${name} <ISO-8601 timestamp> is required`);
  return ms;
}

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createPool(databaseUrl, 4, "aumbram-cli");
  try {
    switch (command) {
      case "migrate":
        print({ applied: await migrate(pool, resolve("migrations"), (m) => process.stdout.write(`${m}\n`)) });
        return 0;
      case "seed": {
        const dir = args[0];
        if (!dir) throw new Error("usage: seed <generator-output-dir>");
        print(await seedReferenceData(pool, resolve(dir)));
        return 0;
      }
      case "sweep": {
        const asOf = flag(args, "--as-of") === undefined ? Date.now() : requireTimestamp(args, "--as-of");
        print(await runCommissionSweep(pool, asOf));
        return 0;
      }
      case "check-invariants": {
        const report = await checkInvariants(pool);
        await recordInvariantCheck(pool, report);
        print(report);
        return report.ok ? 0 : 2;
      }
      case "backfill-events": {
        const file = flag(args, "--file");
        if (!file) throw new Error("usage: backfill-events --file <events.csv>");
        print(await backfillEventsCsv(pool, resolve(file)));
        return 0;
      }
      case "reattribute": {
        const rule = getRule(process.env.ATTRIBUTION_RULE_VERSION ?? "v1");
        print(await reattributeRange(pool, requireTimestamp(args, "--from"), requireTimestamp(args, "--to"), rule));
        return 0;
      }
      default:
        process.stderr.write("commands: migrate | seed <dir> | sweep [--as-of iso] | check-invariants | backfill-events --file f | reattribute --from iso --to iso\n");
        return 1;
    }
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);