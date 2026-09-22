# Aumbram Shared Domain Model

Every assignment uses this model. You may extend it (say so in your README), but don't
contradict it. Field names are `camelCase` in JSON APIs and may be `snake_case` in SQL.

## Conventions

- **IDs** are prefixed strings: `usr_…`, `crt_…`, `vnd_…`, `prd_…`, `var_…`, `sty_…`, `fi_…` (feed item), `ord_…`, `pay_…`. Analytics event ids are client-generated UUIDs (no prefix).
- **Money** is an integer number of **paise** with a currency: `{ "amount": 49900, "currency": "INR" }`. Never use floats for money.
- **Timestamps** are ISO-8601 in UTC: `2026-09-13T08:30:00Z`. Display in IST (`Asia/Kolkata`).
- **Pagination** is cursor-based: `?cursor=<opaque>&limit=20` → `{ "items": [...], "nextCursor": "..." | null }`.
- **Errors** follow a single shape:
  ```json
  { "error": { "code": "OUT_OF_STOCK", "message": "Only 2 left in size M", "details": { "variantId": "var_91", "available": 2 } } }
  ```

## Entity relationships

```
User 1───0..1 Creator            Vendor 1───* Product 1───* Variant
  │                                                  ▲
  ├──* Follow ──> Creator | Vendor                  │ tagged in
  ├──1 Cart 1───* CartLine ──> Variant       Story *─┘
  ├──* Order 1───* OrderLine ──> Variant       ▲
  │      └──* Payment                          │ published by
  │      └── attribution ──> Story / Creator ──┘
  └──* Event (impression, tap, add_to_cart, purchase …)
```

## Entities

### User
| Field | Type | Notes |
|---|---|---|
| `id` | string | `usr_…` |
| `phone` | string | E.164, `+9198…`. Primary login (OTP). |
| `name` | string | |
| `preferredLanguage` | `"en" \| "hi"` | |
| `defaultPincode` | string? | 6 digits |
| `createdAt` | timestamp | |

### Creator
| Field | Type | Notes |
|---|---|---|
| `id` | string | `crt_…` |
| `userId` | string | |
| `handle` | string | unique, `@meera.weaves` |
| `displayName` | string | |
| `avatarUrl` | string | |
| `followerCount` | int | denormalised |
| `commissionRateBps` | int | basis points; `500` = 5% |
| `verified` | bool | |

### Vendor
| Field | Type | Notes |
|---|---|---|
| `id` | string | `vnd_…` |
| `name` | string | "Bagru Block Prints" |
| `city`, `state` | string | |
| `gstin` | string? | optional for very small sellers |
| `rating` | number | 0–5, one decimal |
| `codEnabled` | bool | |
| `serviceablePincodePrefixes` | string[] | e.g. `["30", "11", "56"]` |

### Product
| Field | Type | Notes |
|---|---|---|
| `id` | string | `prd_…` |
| `vendorId` | string | |
| `title` | string | up to 120 chars |
| `description` | string | markdown-lite |
| `category` | string | `apparel`, `home-decor`, `jewellery`, `beauty`, `food`, `crafts` |
| `images` | `{ url, width, height, blurhash? }[]` | |
| `priceRange` | `{ min: Money, max: Money }` | denormalised from variants |
| `mrp` | Money? | list price for showing discount |
| `tags` | string[] | |
| `status` | `"draft" \| "active" \| "archived"` | |
| `ratingAvg`, `ratingCount` | number, int | |
| `variants` | Variant[] | nested in API responses and in `products.json` |

### Variant
| Field | Type | Notes |
|---|---|---|
| `id` | string | `var_…` |
| `productId` | string | |
| `sku` | string | unique per vendor |
| `options` | `Record<string,string>` | `{ "size": "M", "colour": "Indigo" }` |
| `price` | Money | |
| `stock` | int | ≥ 0. **Source of truth for overselling.** |

### Story
| Field | Type | Notes |
|---|---|---|
| `id` | string | `sty_…` |
| `creatorId` | string | |
| `segments` | `{ type: "image" \| "video", url, durationMs, posterUrl? }[]` | 1–10 segments |
| `caption` | string | |
| `taggedProducts` | `{ productId, segmentIndex, x, y }[]` | x/y are 0–1 positions of a tag on the frame |
| `publishedAt` | timestamp | |
| `expiresAt` | timestamp? | null = permanent |
| `stats` | `{ views, likes, shares }` | |

### FeedItem (discriminated union)
```ts
type FeedItem =
  | { id: string; type: "product"; product: Product; reason?: "trending" | "followed_vendor" | "similar" }
  | { id: string; type: "story";   story: Story; creator: Creator; products: Product[] }
  | { id: string; type: "creator"; creator: Creator; sampleProducts: Product[] }
  | { id: string; type: "promo";   title: string; imageUrl: string; deeplink: string; endsAt: string };

// Live elements pushed after load (SSE / WebSocket / polling):
type LiveUpdate =
  | { type: "stock";       variantId: string; stock: number }
  | { type: "price_drop";  productId: string; newMin: Money }
  | { type: "live_viewers"; storyId: string; count: number };
```

### Cart / CartLine
| Field | Type | Notes |
|---|---|---|
| `cart.userId` | string | one active cart per user |
| `line.variantId` | string | |
| `line.quantity` | int | 1–10 |
| `line.priceAtAdd` | Money | price may change before checkout |
| `line.attribution` | `{ storyId?, creatorId? }` | where the add happened |

### Order
| Field | Type | Notes |
|---|---|---|
| `id` | string | `ord_…` |
| `userId`, `vendorId` | string | **one order per vendor**; a multi-vendor cart splits into several orders |
| `lines` | `{ variantId, quantity, unitPrice: Money }[]` | price frozen at checkout |
| `subtotal`, `shippingFee`, `total` | Money | |
| `paymentMethod` | `"upi" \| "card" \| "cod"` | |
| `status` | see state machine | |
| `shippingAddress` | `{ name, line1, line2?, city, state, pincode, phone }` | |
| `attribution` | `{ storyId?, creatorId? }` | |
| `idempotencyKey` | string | client-generated; prevents duplicate orders on retry |
| `payments` | Payment[] | nested in `orders.json` |
| `deliveredAt` | timestamp? | set on `delivered`; starts the 7-day return window |
| `createdAt`, `updatedAt` | timestamp | |

#### Order state machine
```
Prepaid (UPI / card):
  pending_payment ──► paid ──► packed ──► shipped ──► delivered ──► return_requested ──► returned

Cash on delivery:
  confirmed ──► packed ──► shipped ──► delivered ──► return_requested ──► returned

Cancellation: pending_payment | paid | confirmed | packed ──► cancelled
```
- A failed payment attempt sets the **Payment** to `failed`; the order stays `pending_payment` so the buyer can retry.
- `pending_payment → cancelled` automatically after 15 min unpaid (stock is released).
- The buyer may cancel while the order is `pending_payment`, `paid` or `confirmed` (i.e. before it is `packed`). The vendor may also cancel a `packed` order (i.e. any time before `shipped`). Cancelling a paid order triggers a refund (Payment → `refunded`).
- Returns are allowed within 7 days of `delivered`.

### Payment
| Field | Type | Notes |
|---|---|---|
| `id` | string | `pay_…` |
| `orderId` | string | |
| `provider` | string | mock gateway in assignments |
| `providerRef` | string | gateway's transaction id; **webhooks may arrive twice or out of order** |
| `status` | `"created" \| "authorized" \| "captured" \| "failed" \| "refunded"` | |
| `amount` | Money | |

### Event (analytics)
| Field | Type | Notes |
|---|---|---|
| `id` | string | client-generated UUID, used for dedupe |
| `userId` | string? | null for logged-out sessions |
| `sessionId` | string | |
| `name` | `"feed_impression" \| "card_tap" \| "story_view" \| "story_product_tap" \| "add_to_cart" \| "checkout_start" \| "purchase"` | |
| `props` | object | e.g. `{ feedItemId, position, storyId, productId, value }` |
| `clientTs`, `serverTs` | timestamp | clocks on phones are wrong; trust `serverTs` for ordering |
| `device` | `{ os, model, network: "wifi" \| "4g" \| "3g" \| "offline" }` | |

## Shipping fee

Computed **per order, i.e. per vendor**: free when the order subtotal is **≥ ₹499 (49900 paise)**, otherwise **₹49 (4900 paise)**.

## Attribution rule (used by Backend, Full Stack and Data tracks)

A purchase is attributed to the **last story the user interacted with** (`story_view` with
`props.watchMs ≥ 3000`, or `story_product_tap`) **where that story tags at least one product in the
order** (and therefore from the same vendor), **within 72 hours before `checkout_start`**. If none
qualifies, the order is unattributed. Individual assignments may pin down further details
(e.g. how a `checkout_start` is matched to an order); where they do, the assignment wins.
Creator commission = `order.subtotal × creator.commissionRateBps / 10000`, rounded **down** to
the paisa, and paid only once the order is `delivered` and past the 7-day return window.
