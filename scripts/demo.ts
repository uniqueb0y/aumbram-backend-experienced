/**
 * End-to-end demo (BE-E-16) against a running stack:
 *   ingest events (skewed phone clock + a duplicate) -> order events ->
 *   late offline event re-attributes -> return reverses -> sweep -> earnings.
 *
 *   docker compose up -d && docker compose run --rm demo
 *   (or on the host: npm run build && API_URL=http://localhost:8080 npm run demo)
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const API = process.env.API_URL ?? "http://localhost:8080";
const APP_KEY = process.env.APP_KEY ?? "dev_app_key_change_me";
const INTERNAL = process.env.INTERNAL_TOKEN ?? "dev_internal_token_change_me";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Json = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const rupees = (paise: unknown) => `${Number(paise) < 0 ? "-" : ""}₹${(Math.abs(Number(paise)) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
const say = (s: string) => process.stdout.write(`${s}\n`);
const step = (n: number, s: string) => say(`\n\x1b[1m${n}. ${s}\x1b[0m`);

async function call(method: string, path: string, body?: unknown, internal = false): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(internal ? { "x-internal-token": INTERNAL } : { "x-app-key": APP_KEY }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : {} };
}

async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function attribution(orderId: string, creatorId: string): Promise<Json> {
  return waitFor(`${orderId} attributed to ${creatorId}`, async () => {
    const r = await call("GET", `/v1/orders/${orderId}/attribution?history=true`);
    return r.status === 200 && r.json.creatorId === creatorId ? r.json : null;
  });
}

/** Waits until the worker has consumed every queued event. */
async function eventsProcessed(): Promise<void> {
  await waitFor("event queue to drain", async () => {
    const q = (await call("GET", "/health")).json.queue as Json | undefined;
    return q && q.eventDepth === 0 ? true : null;
  });
}

async function orderLedger(creatorId: string, orderIds: string[]): Promise<Json[]> {
  const lines: Json[] = [];
  let cursor = "";
  for (;;) {
    const r = await call("GET", `/v1/creators/${creatorId}/ledger?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    const items = (r.json.items as Json[]) ?? [];
    lines.push(...items.filter((i) => orderIds.includes(String(i.orderId))));
    if (!r.json.nextCursor) return lines;
    cursor = String(r.json.nextCursor);
  }
}

function loadReferenceData() {
  const dir = mkdtempSync(join(tmpdir(), "aumbram-ref-"));
  execFileSync(process.execPath, [resolve("shared/mock-data/generate.mjs"), "--events", "0", "--out", dir], { stdio: "ignore" });
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Json[];
  return { stories: read("stories.json"), products: read("products.json") };
}

async function main(): Promise<void> {
  const health = await call("GET", "/health");
  if (health.status !== 200) throw new Error(`API not healthy at ${API}: ${JSON.stringify(health.json)}`);

  // Pick a tagged product, its story (creator X) and a story by another creator (Y).
  const { stories, products } = loadReferenceData();
  const tagged = (s: Json) => (s.taggedProducts as Json[]).map((t) => String(t.productId));
  const storyX = stories.find((s) => tagged(s).length > 0);
  if (!storyX) throw new Error("no tagged story in reference data");
  const productId = tagged(storyX)[0] as string;
  const product = products.find((p) => p.id === productId);
  const storyY = stories.find((s) => s.creatorId !== storyX.creatorId);
  if (!product || !storyY) throw new Error("reference data incomplete");
  const variant = (product.variants as Json[])[0] as Json;
  const unitPrice = Number((variant.price as Json).amount);
  const X = String(storyX.creatorId);
  const Y = String(storyY.creatorId);

  const run = randomUUID().slice(0, 8);
  const user = `usr_demo_${run}`;
  const session = randomUUID();
  const now = Date.now();
  say(`Demo run ${run}: user ${user}, product ${productId} (vendor ${product.vendorId})`);
  say(`Story X = ${storyX.id} by ${X};  story Y = ${storyY.id} by ${Y}`);

  step(1, "Phone with a clock 5.5 h FAST sends a batch (plus a retried duplicate)");
  const skew = 5.5 * HOUR;
  const viewId = randomUUID();
  const ev = (id: string, name: string, props: Json, realTs: number) => ({
    id,
    userId: user,
    sessionId: session,
    name,
    props,
    clientTs: iso(realTs + skew),
    device: { os: "android", model: "Redmi Note 12", network: "3g" },
  });
  const batch1 = await call("POST", "/v1/events/batch", {
    sentAt: iso(now + skew),
    events: [
      ev(viewId, "story_view", { storyId: storyX.id, watchMs: 4200, creatorId: "crt_spoofed" }, now - 3 * HOUR),
      ev(`evt_${viewId}`, "story_view", { storyId: storyX.id, watchMs: 4200 }, now - 3 * HOUR), // same event, evt_ prefix
      ev(randomUUID(), "story_view", { storyId: storyX.id, watchMs: 1500 }, now - 30 * MIN), // too short to qualify
      ev(randomUUID(), "checkout_start", {}, now - MIN),
      { id: "not-a-uuid", name: "story_view" }, // rejected, the rest still accepted
    ],
  });
  say(`   -> ${batch1.status} ${JSON.stringify({ accepted: batch1.json.accepted, duplicates: batch1.json.duplicates, rejected: (batch1.json.rejected as Json[]).map((r) => r.code) })}`);
  await eventsProcessed();

  const order1 = { orderId: `ord_demo_${run}_1`, subtotal: unitPrice * 2 };
  const order2 = { orderId: `ord_demo_${run}_2`, subtotal: unitPrice };
  const snapshot = (o: { orderId: string; subtotal: number }, quantity: number) => ({
    userId: user,
    vendorId: product.vendorId,
    lines: [{ variantId: variant.id, quantity, unitPrice: { amount: unitPrice, currency: "INR" } }],
    subtotal: { amount: o.subtotal, currency: "INR" },
    createdAt: iso(now),
  });
  const orderEvent = (o: typeof order1, qty: number, status: string, at: number) =>
    call("POST", "/v1/internal/order-events", { orderId: o.orderId, status, occurredAt: iso(at), order: snapshot(o, qty) }, true);

  step(2, `Order ${order1.orderId} is created and delivered (${rupees(order1.subtotal)})`);
  await orderEvent(order1, 2, "delivered", now + 2 * DAY); // out of order: delivered first
  await orderEvent(order1, 2, "created", now);
  const a1 = await attribution(order1.orderId, X);
  say(`   -> attributed to ${a1.storyId} / ${a1.creatorId} via ${(a1.qualifyingEvent as Json).name} at ${(a1.qualifyingEvent as Json).serverTs}`);
  say(`      anchor ${JSON.stringify(a1.anchor)}; commission ${rupees((a1.commission as Json).amount)} at ${a1.commissionRateBps} bps (props.creatorId was spoofed and ignored)`);

  step(3, "A phone that was offline uploads a late tap on the same product in story Y (2 h before checkout)");
  const late = await call("POST", "/v1/events/batch", {
    sentAt: iso(now),
    events: [
      { id: randomUUID(), userId: user, sessionId: session, name: "story_product_tap", props: { storyId: storyY.id, productId }, clientTs: iso(now - 2 * HOUR) },
    ],
  });
  say(`   -> ${late.status} accepted=${late.json.accepted}`);
  await eventsProcessed();
  const a2 = await attribution(order1.orderId, Y);
  say(`   -> version ${a2.version}: now ${a2.storyId} / ${a2.creatorId}; commission ${rupees((a2.commission as Json).amount)}`);

  step(4, `Order ${order2.orderId}: delivered, return requested, returned (the 'returned' message arrives twice)`);
  await orderEvent(order2, 1, "created", now);
  await orderEvent(order2, 1, "delivered", now + 2 * DAY);
  await orderEvent(order2, 1, "return_requested", now + 5 * DAY);
  await orderEvent(order2, 1, "returned", now + 8 * DAY);
  const dup = await orderEvent(order2, 1, "returned", now + 8 * DAY);
  say(`   -> duplicate 'returned' acknowledged with duplicate=${dup.json.duplicate}`);
  await waitFor("order 2 reversal", async () => ((await orderLedger(Y, [order2.orderId])).some((l) => l.type === "reverse") ? true : null));

  step(5, "Commission sweep as of deliveredAt + 8 days");
  const sw = await call("POST", "/v1/internal/jobs/commission-sweep", { asOf: iso(now + 10 * DAY) }, true);
  say(`   -> ${JSON.stringify(sw.json)}`);

  step(6, "Ledger lines for this demo's orders (creator's view: + = owed to creator)");
  for (const c of [X, Y]) {
    for (const l of await orderLedger(c, [order1.orderId, order2.orderId])) {
      say(`   ${c}  ${String(l.orderId).padEnd(24)} ${String(l.type).padEnd(12)} ${String(l.account).padEnd(8)} ${rupees((l.amount as Json).amount)}`);
    }
  }

  step(7, "Earnings (whole ledger for each creator, one consistent snapshot)");
  for (const c of [X, Y]) {
    const e = (await call("GET", `/v1/creators/${c}/earnings`)).json;
    say(
      `   ${c}: accrued ${rupees((e.accrued as Json).amount)}, payable ${rupees((e.payable as Json).amount)}, reversed ${rupees((e.reversed as Json).amount)}, lifetime ${rupees((e.lifetimeEarned as Json).amount)} (ledgerSequence ${e.ledgerSequence})`,
    );
  }
  const final = await call("GET", `/v1/orders/${order1.orderId}/attribution`);
  say(`\nOrder 1 is now locked=${final.json.locked} (${final.json.lockReason}); later events can no longer change it.`);
  say("Done.");
}

main().catch((err: unknown) => {
  process.stderr.write(`demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});