/** Loads reference data (creators, products, variants, stories) produced by the mock-data generator. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { isPlainObject } from "../ingest/validate.js";
import { ensureCreatorAccounts } from "../ledger/posting.js";

async function readArray(dir: string, file: string): Promise<unknown[]> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
  return parsed;
}

function field(obj: unknown, key: string): unknown {
  return isPlainObject(obj) ? obj[key] : undefined;
}

function requireString(obj: unknown, key: string, file: string): string {
  const v = field(obj, key);
  if (typeof v !== "string") throw new Error(`${file}: expected string field "${key}"`);
  return v;
}

export interface SeedCounts {
  creators: number;
  products: number;
  variants: number;
  stories: number;
}

export async function seedReferenceData(pool: Pool, dir: string): Promise<SeedCounts> {
  const creators = (await readArray(dir, "creators.json")).map((c) => {
    const rate = field(c, "commissionRateBps");
    if (typeof rate !== "number" || !Number.isInteger(rate)) throw new Error("creators.json: commissionRateBps must be an integer");
    return { id: requireString(c, "id", "creators.json"), rate };
  });
  const products = await readArray(dir, "products.json");
  const productRows = products.map((p) => ({ id: requireString(p, "id", "products.json"), vendorId: requireString(p, "vendorId", "products.json") }));
  const variantRows = products.flatMap((p) => {
    const variants = field(p, "variants");
    if (!Array.isArray(variants)) return [];
    return variants.map((v) => ({ id: requireString(v, "id", "products.json"), productId: requireString(p, "id", "products.json") }));
  });
  const storyRows = (await readArray(dir, "stories.json")).map((s) => {
    const tagged = field(s, "taggedProducts");
    const productIds = Array.isArray(tagged) ? [...new Set(tagged.map((t) => requireString(t, "productId", "stories.json")))] : [];
    return { id: requireString(s, "id", "stories.json"), creatorId: requireString(s, "creatorId", "stories.json"), productIds };
  });

  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO creators (id, commission_rate_bps)
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text, rate integer)
       ON CONFLICT (id) DO UPDATE SET commission_rate_bps = EXCLUDED.commission_rate_bps`,
      [JSON.stringify(creators)],
    );
    await tx.query(
      `INSERT INTO products (id, vendor_id)
       SELECT id, "vendorId" FROM jsonb_to_recordset($1::jsonb) AS x(id text, "vendorId" text)
       ON CONFLICT (id) DO UPDATE SET vendor_id = EXCLUDED.vendor_id`,
      [JSON.stringify(productRows)],
    );
    await tx.query(
      `INSERT INTO variants (id, product_id)
       SELECT id, "productId" FROM jsonb_to_recordset($1::jsonb) AS x(id text, "productId" text)
       ON CONFLICT (id) DO UPDATE SET product_id = EXCLUDED.product_id`,
      [JSON.stringify(variantRows)],
    );
    await tx.query(
      `INSERT INTO stories (id, creator_id, tagged_product_ids)
       SELECT id, "creatorId", ARRAY(SELECT jsonb_array_elements_text("productIds"))
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, "creatorId" text, "productIds" jsonb)
       ON CONFLICT (id) DO UPDATE SET creator_id = EXCLUDED.creator_id, tagged_product_ids = EXCLUDED.tagged_product_ids`,
      [JSON.stringify(storyRows)],
    );
    for (const c of creators) await ensureCreatorAccounts(tx, c.id);
  });

  return { creators: creators.length, products: productRows.length, variants: variantRows.length, stories: storyRows.length };
}