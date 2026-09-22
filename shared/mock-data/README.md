# Mock data

```bash
node generate.mjs                                   # writes ./out with default sizes
node generate.mjs --seed 7 --events 500000 --out ./big
```

Flags: `--seed --vendors --creators --products --stories --users --events --out`.
The same seed always produces the same data, so reviewers and candidates see identical files.

| File | Contents | Used by |
|---|---|---|
| `feed.json` | 300 ranked `FeedItem`s (product / story / creator / promo) | Frontend, Mobile, Full Stack, QA |
| `live-updates.jsonl` | 500 `LiveUpdate`s to replay (stock, price drop, live viewers) | Frontend, Mobile |
| `products.json` | Products with nested variants (some sold out, some long titles, some 0 ratings) | all |
| `vendors.json`, `creators.json`, `stories.json` | Reference entities | all |
| `orders.json` | Orders with payments. About 3% have **duplicated payment records** (simulated duplicate webhooks). | Backend, Full Stack, Data, QA |
| `events.csv` | Funnel events. Deliberately dirty: about 1% duplicate `event_id`s, 5% of devices with skewed clocks, 15% logged-out sessions, rare unknown `productId`s. | Data, Backend, DevOps |

Images are placeholder URLs (picsum.photos for products and stories, i.pravatar.cc for avatars); video URLs are fake and should be treated as unavailable.

## Known quirks (synthetic data, not business rules)

The generator is deliberately simple. Where data and [`domain-model.md`](../domain-model.md) disagree,
**the domain model is the spec**. Your assignment tells you if you are expected to clean, reject or ignore these:

- `orders.json` statuses are sampled independently of payment method, so some COD orders show `paid`/`pending_payment` (the spec says COD → `confirmed`); some COD orders belong to vendors with `codEnabled: false`; shipping pincodes ignore vendor serviceability; returned orders keep `captured` payments.
- `orders.json` `attribution` and `purchase` events' `orderId` are randomly sampled, so they are **not** ground truth for the attribution rule.
- Duplicated payment records repeat the same payment `id` and `providerRef`.
- Some products have `ratingAvg: 0` with a non-zero `ratingCount`; some vendor names repeat; GSTINs are fake and all start with `08`.
- `live-updates.jsonl` stock values are derived from the original stock (not the previous update), and `price_drop.newMin` may not match any variant price.
- Stories with `expiresAt` are already expired relative to September 2026; treat expiry as out of scope unless your assignment says otherwise.
- Within a session, `server_ts` can occasionally go backwards relative to row order (ingest jitter).
- Changing `--products` (or any size flag) changes the whole random sequence, so smaller runs are not prefixes of the default run.
Generated `out/` directories should not be committed.
