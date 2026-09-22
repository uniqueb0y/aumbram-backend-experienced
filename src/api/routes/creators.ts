import type { FastifyInstance } from "fastify";
import type { Pool } from "../../db/pool.js";
import { getEarnings, listCreatorLedger } from "../../ledger/read.js";
import { ApiError } from "../../lib/errors.js";
import { moneyJson } from "../../lib/money.js";
import { toIso } from "../../lib/time.js";
import type { AuthHooks } from "../auth.js";
import { decodeCursor, encodeCursor, safeNumber } from "../json.js";

async function assertCreatorExists(pool: Pool, creatorId: string): Promise<void> {
  const { rowCount } = await pool.query("SELECT 1 FROM creators WHERE id = $1", [creatorId]);
  if (!rowCount) throw new ApiError(404, "NOT_FOUND", `unknown creator ${creatorId}`);
}

export function registerCreatorRoutes(app: FastifyInstance, deps: { pool: Pool; auth: AuthHooks }): void {
  app.get<{ Params: { creatorId: string } }>("/v1/creators/:creatorId/earnings", { onRequest: deps.auth.any }, async (request) => {
    const { creatorId } = request.params;
    await assertCreatorExists(deps.pool, creatorId);
    const e = await getEarnings(deps.pool, creatorId);
    return {
      creatorId,
      asOf: toIso(e.asOf),
      accrued: moneyJson(e.accrued),
      payable: moneyJson(e.payable),
      reversed: moneyJson(e.reversed),
      lifetimeEarned: moneyJson(e.lifetimeEarned),
      orderCounts: e.orderCounts,
      ledgerSequence: safeNumber(e.ledgerSequence),
    };
  });

  app.get<{ Params: { creatorId: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/v1/creators/:creatorId/ledger",
    { onRequest: deps.auth.any },
    async (request) => {
      const { creatorId } = request.params;
      const after = decodeCursor(request.query.cursor);
      if (after === null) throw new ApiError(400, "INVALID_CURSOR", "cursor is not valid");
      const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, "INVALID_LIMIT", "limit must be an integer in [1, 200]");
      await assertCreatorExists(deps.pool, creatorId);

      const rows = await listCreatorLedger(deps.pool, creatorId, after, limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((l) => ({
          entryId: safeNumber(l.entryId),
          transactionId: safeNumber(l.transactionId),
          orderId: l.orderId,
          type: l.type,
          account: l.account,
          amount: moneyJson(l.amount),
          attributionVersion: l.attributionVersion,
          reason: l.reason,
          createdAt: toIso(l.createdAt),
        })),
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.entryId) : null,
      };
    },
  );
}