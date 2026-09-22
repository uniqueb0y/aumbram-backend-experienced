#!/usr/bin/env node
// Aumbram mock data generator — deterministic, zero dependencies, Node 18+.
//
//   node generate.mjs                       # defaults, writes ./out
//   node generate.mjs --seed 42 --products 300 --events 200000 --out ./data
//
// Outputs (see ../domain-model.md for shapes):
//   vendors.json, creators.json, products.json (with variants), stories.json,
//   feed.json (ranked FeedItem[]), orders.json, events.csv, live-updates.jsonl
//
// Deliberate "dirty data" is injected into events.csv and orders.json so Data, Backend
// and QA candidates have something real to handle: duplicate event ids, skewed client
// clocks, events for unknown products, and webhook-style duplicate payments.

import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const SEED = Number(args.seed ?? 20260913);
const N_VENDORS = Number(args.vendors ?? 25);
const N_CREATORS = Number(args.creators ?? 40);
const N_PRODUCTS = Number(args.products ?? 200);
const N_STORIES = Number(args.stories ?? 120);
const N_USERS = Number(args.users ?? 2000);
const N_EVENTS = Number(args.events ?? 50000);
const OUT = resolve(args.out ?? "./out");

// ---------- deterministic PRNG (mulberry32) ----------
let state = SEED >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const pad = (n, w = 4) => String(n).padStart(w, "0");
const money = (amount) => ({ amount, currency: "INR" });
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(rand() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

const BASE_TIME = Date.parse("2026-08-01T00:00:00Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const img = (seed, w, h) => ({ url: `https://picsum.photos/seed/${seed}/${w}/${h}`, width: w, height: h });

// ---------- reference vocab ----------
const CITIES = [
  ["Jaipur", "Rajasthan", "30"], ["Bagru", "Rajasthan", "30"], ["Varanasi", "Uttar Pradesh", "22"],
  ["Kutch", "Gujarat", "37"], ["Bengaluru", "Karnataka", "56"], ["Kolkata", "West Bengal", "70"],
  ["Pune", "Maharashtra", "41"], ["Delhi", "Delhi", "11"], ["Kochi", "Kerala", "68"],
  ["Bhubaneswar", "Odisha", "75"], ["Guwahati", "Assam", "78"], ["Lucknow", "Uttar Pradesh", "22"],
];
const CATEGORIES = {
  apparel: { nouns: ["Kurta", "Saree", "Dupatta", "Kurti", "Nehru Jacket", "Palazzo"], price: [49900, 499900], options: { size: ["XS", "S", "M", "L", "XL"], colour: ["Indigo", "Madder Red", "Mustard", "Ivory", "Forest Green"] } },
  "home-decor": { nouns: ["Cushion Cover", "Table Runner", "Dhurrie", "Wall Hanging", "Bedsheet"], price: [29900, 349900], options: { colour: ["Indigo", "Terracotta", "Natural"] } },
  jewellery: { nouns: ["Jhumkas", "Oxidised Necklace", "Silver Anklet", "Bangles Set", "Nose Pin"], price: [19900, 249900], options: { finish: ["Oxidised", "Gold-plated", "Silver"] } },
  beauty: { nouns: ["Kumkumadi Oil", "Ubtan Pack", "Rose Water Toner", "Neem Soap", "Kajal"], price: [14900, 129900], options: { size: ["50ml", "100ml"] } },
  food: { nouns: ["Mango Pickle", "Darjeeling Tea", "Jaggery Cubes", "Millet Cookies", "Masala Chai Mix"], price: [9900, 89900], options: { weight: ["250g", "500g", "1kg"] } },
  crafts: { nouns: ["Madhubani Painting", "Terracotta Planter", "Dokra Figurine", "Bamboo Basket", "Pattachitra Scroll"], price: [39900, 899900], options: {} },
};
const ADJ = {
  apparel: ["Hand-block Printed", "Handwoven", "Ajrakh", "Chikankari", "Kalamkari", "Bandhani", "Ikat"],
  "home-decor": ["Hand-block Printed", "Handwoven", "Ajrakh", "Kalamkari", "Jute", "Upcycled"],
  jewellery: ["Tribal", "Kundan", "Handcrafted", "Temple", "Meenakari"],
  beauty: ["Organic", "Ayurvedic", "Cold-pressed", "Handmade", "Herbal"],
  food: ["Organic", "Homemade", "Small-batch", "Stone-ground", "Heritage"],
  crafts: ["Artisanal", "Heritage", "Hand-painted", "GI-tagged", "Handcrafted"],
};
const VENDOR_WORDS = ["Weaves", "Crafts", "Collective", "Studio", "Karigar", "Haat", "Looms", "Naturals", "Kala", "Bazaar"];
const FIRST = ["Meera", "Arjun", "Ananya", "Kabir", "Ishita", "Rohan", "Priya", "Vikram", "Sana", "Aditya", "Nandini", "Farhan", "Lakshmi", "Dev", "Zoya"];
const CAPTIONS = [
  "Styling this for Diwali 🪔", "3 ways to wear one dupatta", "Behind the loom with the artisans",
  "Under ₹999 finds you'll love", "Yeh kurta toh must-have hai!", "Unboxing my handmade haul",
  "Monsoon-ready cottons", "Gifting ideas for Rakhi", "Is it worth the hype? Honest review",
];

// ---------- vendors ----------
const vendors = Array.from({ length: N_VENDORS }, (_, i) => {
  const [city, st, prefix] = pick(CITIES);
  const prefixes = new Set([prefix]);
  while (prefixes.size < int(2, 8)) prefixes.add(pick(CITIES)[2]);
  return {
    id: `vnd_${pad(i + 1)}`,
    name: `${city} ${pick(VENDOR_WORDS)}`,
    city, state: st,
    gstin: chance(0.6) ? `08ABCDE${pad(int(0, 9999))}F1Z${int(1, 9)}` : null,
    rating: Math.round((3.2 + rand() * 1.8) * 10) / 10,
    codEnabled: chance(0.7),
    serviceablePincodePrefixes: [...prefixes],
  };
});

// ---------- creators ----------
const creators = Array.from({ length: N_CREATORS }, (_, i) => {
  const name = pick(FIRST);
  return {
    id: `crt_${pad(i + 1)}`,
    userId: `usr_${pad(i + 1, 6)}`,
    handle: `@${name.toLowerCase()}.${pick(["styles", "weaves", "finds", "desi", "crafts", "hauls"])}${i}`,
    displayName: `${name} ${pick(["Sharma", "Iyer", "Khan", "Das", "Patel", "Reddy", "Singh", "Bose"])}`,
    avatarUrl: `https://i.pravatar.cc/150?u=crt_${i + 1}`,
    // heavy-tailed follower distribution: a few big creators, many small ones
    followerCount: Math.floor(500 * Math.pow(1 / (rand() + 0.01), 1.6)),
    commissionRateBps: pick([300, 500, 500, 700, 1000]),
    verified: chance(0.25),
  };
});

// ---------- products + variants ----------
const cartesian = (options) =>
  Object.entries(options).reduce((acc, [k, vals]) => acc.flatMap((combo) => vals.map((v) => ({ ...combo, [k]: v }))), [{}]);

let variantSeq = 0;
const products = Array.from({ length: N_PRODUCTS }, (_, i) => {
  const category = pick(Object.keys(CATEGORIES));
  const cat = CATEGORIES[category];
  const vendor = pick(vendors);
  const base = Math.round(int(cat.price[0], cat.price[1]) / 10000) * 10000 - 100; // ₹x99 pricing, e.g. 129900 = ₹1,299
  const combos = cartesian(Object.fromEntries(Object.entries(cat.options).map(([k, v]) => [k, v.slice(0, int(1, v.length))])));
  const variants = combos.map((options) => ({
    id: `var_${pad(++variantSeq, 5)}`,
    productId: `prd_${pad(i + 1)}`,
    sku: `${vendor.id.slice(4)}-${pad(i + 1)}-${pad(variantSeq, 5)}`,
    options,
    price: money(base + (options.size === "XL" || options.weight === "1kg" ? 10000 : 0)),
    stock: chance(0.12) ? 0 : chance(0.2) ? int(1, 3) : int(4, 80), // some sold out, some "only N left"
  }));
  const prices = variants.map((v) => v.price.amount);
  const title = `${pick(ADJ[category])} ${pick(cat.nouns)}`;
  return {
    id: `prd_${pad(i + 1)}`,
    vendorId: vendor.id,
    title: chance(0.08) ? `${title} — Limited Festive Edition with Traditional Motifs, Pure Cotton, Handcrafted by Artisans` : title, // some long titles
    description: `${title} made by ${vendor.name}, ${vendor.city}. Each piece is unique; slight irregularities are a mark of handwork.`,
    category,
    images: Array.from({ length: int(1, 5) }, (_, k) => img(`prd${i + 1}-${k}`, 800, pick([800, 1000, 1200]))),
    priceRange: { min: money(Math.min(...prices)), max: money(Math.max(...prices)) },
    mrp: chance(0.6) ? money(Math.round((Math.max(...prices) * (1.2 + rand() * 0.6)) / 100) * 100) : null,
    tags: [category, pick(ADJ[category]).toLowerCase(), pick(["festive", "everyday", "gifting", "bestseller", "new"])],
    status: chance(0.93) ? "active" : pick(["draft", "archived"]),
    ratingAvg: chance(0.15) ? 0 : Math.round((3 + rand() * 2) * 10) / 10,
    ratingCount: int(0, 2400),
    variants,
  };
});
const activeProducts = products.filter((p) => p.status === "active");

// ---------- stories ----------
const stories = Array.from({ length: N_STORIES }, (_, i) => {
  const creator = pick(creators);
  const segCount = int(1, 6);
  const publishedAt = BASE_TIME + int(0, 40) * DAY + int(0, DAY);
  const tagged = [];
  for (let s = 0; s < segCount; s++) {
    if (chance(0.6)) tagged.push({ productId: pick(activeProducts).id, segmentIndex: s, x: +rand().toFixed(2), y: +rand().toFixed(2) });
  }
  return {
    id: `sty_${pad(i + 1)}`,
    creatorId: creator.id,
    segments: Array.from({ length: segCount }, (_, s) =>
      chance(0.5)
        ? { type: "video", url: `https://example-cdn.aumbram.dev/stories/${i + 1}/${s}.mp4`, durationMs: int(4000, 15000), posterUrl: img(`sty${i + 1}-${s}`, 720, 1280).url }
        : { type: "image", url: img(`sty${i + 1}-${s}`, 720, 1280).url, durationMs: 5000 }
    ),
    caption: pick(CAPTIONS),
    taggedProducts: tagged,
    publishedAt: iso(publishedAt),
    expiresAt: chance(0.5) ? iso(publishedAt + DAY) : null,
    stats: { views: int(100, 250000), likes: int(5, 20000), shares: int(0, 3000) },
  };
});

// ---------- feed ----------
const productById = new Map(products.map((p) => [p.id, p]));
const creatorById = new Map(creators.map((c) => [c.id, c]));
const feed = [];
for (let i = 0; i < Math.min(300, N_PRODUCTS + N_STORIES); i++) {
  const roll = rand();
  if (roll < 0.45) {
    feed.push({ id: `fi_${pad(i + 1)}`, type: "product", product: pick(activeProducts), reason: pick(["trending", "followed_vendor", "similar"]) });
  } else if (roll < 0.8) {
    const story = pick(stories);
    feed.push({
      id: `fi_${pad(i + 1)}`, type: "story", story, creator: creatorById.get(story.creatorId),
      products: [...new Set(story.taggedProducts.map((t) => t.productId))].map((id) => productById.get(id)),
    });
  } else if (roll < 0.93) {
    const creator = pick(creators);
    feed.push({ id: `fi_${pad(i + 1)}`, type: "creator", creator, sampleProducts: [pick(activeProducts), pick(activeProducts), pick(activeProducts)] });
  } else {
    feed.push({
      id: `fi_${pad(i + 1)}`, type: "promo", title: pick(["Festive Sale — up to 40% off", "Free shipping above ₹499", "New: Artisans of Kutch"]),
      imageUrl: img(`promo${i}`, 1200, 600).url, deeplink: `aumbram://collections/${pick(["festive", "kutch", "under-999"])}`,
      endsAt: iso(BASE_TIME + int(30, 60) * DAY),
    });
  }
}

// live updates stream: replay at ~1 line / 500ms in frontend/mobile assignments
const liveUpdates = Array.from({ length: 500 }, () => {
  const roll = rand();
  if (roll < 0.6) { const p = pick(activeProducts); const v = pick(p.variants); return { type: "stock", variantId: v.id, stock: Math.max(0, v.stock - int(0, 3)) }; }
  if (roll < 0.8) { const p = pick(activeProducts); return { type: "price_drop", productId: p.id, newMin: money(Math.max(9900, p.priceRange.min.amount - 5000)) }; }
  return { type: "live_viewers", storyId: pick(stories).id, count: int(3, 4000) };
});

// ---------- orders (with dirty payments) ----------
const orders = [];
for (let i = 0; i < Math.floor(N_USERS * 0.4); i++) {
  const vendor = pick(vendors);
  const vendorProducts = activeProducts.filter((p) => p.vendorId === vendor.id);
  if (!vendorProducts.length) continue;
  const lines = Array.from({ length: int(1, 3) }, () => {
    const p = pick(vendorProducts); const v = pick(p.variants);
    return { variantId: v.id, quantity: int(1, 3), unitPrice: v.price };
  });
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice.amount, 0);
  const shippingFee = subtotal >= 49900 ? 0 : 4900;
  const createdAt = BASE_TIME + int(0, 40) * DAY + int(0, DAY);
  const paymentMethod = pick(["upi", "upi", "upi", "card", "cod"]);
  const status = pick(["pending_payment", "paid", "packed", "shipped", "delivered", "delivered", "delivered", "cancelled", "returned"]);
  const story = chance(0.35) ? pick(stories) : null;
  const [shipCity, shipState, shipPrefix] = pick(CITIES);
  const payments = paymentMethod === "cod" ? [] : [{ id: `pay_${pad(i + 1, 6)}`, provider: "mockpay", providerRef: `mp_${uuid().slice(0, 12)}`, status: status === "pending_payment" ? "created" : status === "cancelled" ? "failed" : "captured", amount: money(subtotal + shippingFee) }];
  if (payments.length && chance(0.03)) payments.push({ ...payments[0] }); // duplicate webhook delivery
  orders.push({
    id: `ord_${pad(i + 1, 6)}`, userId: `usr_${pad(int(1, N_USERS), 6)}`, vendorId: vendor.id,
    lines, subtotal: money(subtotal), shippingFee: money(shippingFee), total: money(subtotal + shippingFee), paymentMethod, status,
    shippingAddress: { name: pick(FIRST), line1: `${int(1, 400)} MG Road`, city: shipCity, state: shipState, pincode: `${shipPrefix}${pad(int(0, 9999))}`, phone: `+919${int(100000000, 999999999)}` },
    attribution: story ? { storyId: story.id, creatorId: story.creatorId } : {},
    idempotencyKey: uuid(), payments, createdAt: iso(createdAt), updatedAt: iso(createdAt + int(0, 10) * DAY),
  });
}

// ---------- events.csv (streamed, with dirty data) ----------
mkdirSync(OUT, { recursive: true });
const write = (name, data) => writeFileSync(join(OUT, name), JSON.stringify(data, null, 2));
write("vendors.json", vendors);
write("creators.json", creators);
write("products.json", products);
write("stories.json", stories);
write("feed.json", feed);
write("orders.json", orders);
writeFileSync(join(OUT, "live-updates.jsonl"), liveUpdates.map((u) => JSON.stringify(u)).join("\n") + "\n");

const csv = createWriteStream(join(OUT, "events.csv"));
csv.write("event_id,user_id,session_id,name,props_json,client_ts,server_ts,os,model,network\n");
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const MODELS = ["Redmi Note 12", "Samsung Galaxy M14", "realme Narzo 60", "Moto G54", "iPhone 13", "OnePlus Nord CE3", "Poco X5"];
let emitted = 0;
let lastRow = null;
while (emitted < N_EVENTS) {
  // one session = a funnel walk that may drop off at any stage
  const userId = chance(0.15) ? "" : `usr_${pad(int(1, N_USERS), 6)}`;
  const sessionId = uuid();
  const model = pick(MODELS);
  const os = model.startsWith("iPhone") ? "ios" : "android";
  const network = pick(["4g", "4g", "4g", "wifi", "3g"]);
  const skew = chance(0.05) ? int(-6, 6) * 3_600_000 : int(-3000, 3000); // 5% of phones have wrong clocks
  let t = BASE_TIME + int(0, 40) * DAY + int(0, DAY);
  const emit = (name, props) => {
    if (emitted >= N_EVENTS) return;
    t += int(300, 20000);
    const row = [uuid(), userId, sessionId, name, esc(JSON.stringify(props)), iso(t + skew), iso(t + int(50, 4000)), os, esc(model), network].join(",");
    csv.write(row + "\n");
    emitted++;
    if (chance(0.01)) { csv.write(row + "\n"); emitted++; } // duplicate delivery (same event_id)
    lastRow = row;
  };
  const views = int(3, 25);
  for (let k = 0; k < views; k++) {
    const item = pick(feed);
    emit("feed_impression", { feedItemId: item.id, position: k, type: item.type });
    if (!chance(0.18)) continue;
    emit("card_tap", { feedItemId: item.id, position: k });
    let productId = item.type === "product" ? item.product.id : item.type === "story" && item.products[0] ? item.products[0].id : null;
    if (item.type === "story") {
      emit("story_view", { storyId: item.story.id, creatorId: item.creator.id, watchMs: int(500, 30000) });
      if (productId && chance(0.3)) emit("story_product_tap", { storyId: item.story.id, productId });
    }
    if (chance(0.003)) productId = "prd_9999"; // unknown product reference
    if (productId && chance(0.12)) {
      const value = productById.get(productId)?.priceRange.min.amount ?? 0;
      emit("add_to_cart", { productId, value, storyId: item.type === "story" ? item.story.id : null });
      if (chance(0.45)) {
        emit("checkout_start", { value });
        if (chance(0.55)) { const o = pick(orders); emit("purchase", { orderId: o.id, value: o.total.amount }); }
      }
    }
  }
}
csv.end(() => {
  console.log(`Wrote ${OUT}
  vendors=${vendors.length} creators=${creators.length} products=${products.length} stories=${stories.length}
  feed=${feed.length} orders=${orders.length} liveUpdates=${liveUpdates.length} events=${emitted} (seed ${SEED})`);
});
