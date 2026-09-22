import type { RuleParams } from "../attribution/ruleConfig.js";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { errorMessage } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { deadLetters, orderEventsProcessed } from "../metrics.js";
import { processQueuedOrderEvent } from "../orders/processor.js";

export interface OrderConsumerDeps {
  pool: Pool;
  rule: RuleParams;
  log: Logger;
}

interface ClaimedMessage {
  seq: string;
  orderId: string;
  status: string;
}

/**
 * Claims and processes ONE order message per transaction (claim + effects commit
 * together). Returns false when the queue is empty.
 */
export async function consumeOneOrderEvent(deps: OrderConsumerDeps): Promise<boolean> {
  const state: { claimed: ClaimedMessage | null } = { claimed: null };
  try {
    return await withTransaction(deps.pool, async (tx) => {
      const { rows } = await tx.query<{ seq: bigint; order_id: string; status: string }>(
        `DELETE FROM order_event_queue
         WHERE seq = (SELECT seq FROM order_event_queue ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING seq, order_id, status`,
      );
      const row = rows[0];
      if (!row) return false;
      state.claimed = { seq: row.seq.toString(), orderId: row.order_id, status: row.status };
      await processQueuedOrderEvent(tx, row.order_id, row.status, { rule: deps.rule, log: deps.log });
      orderEventsProcessed.inc({ status: row.status });
      return true;
    });
  } catch (err) {
    const claimed = state.claimed;
    if (claimed === null) throw err;
    // withTransaction already retried transient failures, so this message is poison.
    deps.log.error({ orderId: claimed.orderId, status: claimed.status, err: errorMessage(err) }, "order event moved to dead letters");
    await withTransaction(deps.pool, async (tx) => {
      await tx.query("DELETE FROM order_event_queue WHERE seq = $1", [claimed.seq]);
      await tx.query(
        `INSERT INTO order_event_dead_letters (order_id, status, error) VALUES ($1, $2, $3)
         ON CONFLICT (order_id, status) DO NOTHING`,
        [claimed.orderId, claimed.status, errorMessage(err)],
      );
    });
    deadLetters.inc({ queue: "order_events" });
    return true;
  }
}