# productcatalogservice — Error Analysis

> Time window: 2026-08-21 07:46 – 08:16 UTC (30 min)
> Service: `productcatalogservice` / namespace `opentelemetry-demo`
> Overall error rate: **1.14 %** (135 error spans out of 12 784 total)
> Health status: **critical** (active failed check: "Product Catalog returns > 0.6% errors")

---

## Error patterns ranked by impact

### 1 — Feature-flag-injected INTERNAL error on `GetProduct` (~81 % of all errors)

| Attribute | Value |
|---|---|
| gRPC status code | `13` (INTERNAL) |
| `otel.span.status.message` | `Product Id Lookup Failed: OLJCESPC7Z` |
| `app.product.id` | `OLJCESPC7Z` (National Park Foundation Explorascope 60mm) |
| Correlation coefficient vs all errors | **+81 %** |
| Exemplar trace | `fa67addd05b55310c18d747c57c8a527` span `237a00fce96a4f11` |

**Cause:** The `productCatalogFailure` feature flag (evaluated via flagd) is
**enabled** for a hardcoded set of product SKUs (see `failingProductIDs` in
`main.go`). When enabled, `checkProductFailure` returns `true` for those SKUs
and `GetProduct` immediately returns `codes.Internal` without querying the DB.
The flag was active during the analysis window, producing a ~1.14 % error rate
across the 9 524 `GetProduct` requests.

**Callers affected:** `frontend` (131 errors / 9 708 calls) and `checkoutservice`
(2 errors / 234 calls) both degrade when this flag is on. The `frontend` service
is marked **critical** as a result.

**How to remediate:**
- To stop error injection: disable the `productCatalogFailure` feature flag in
  flagd (`src/flagd/demo.flagd.json` — toggle `productCatalogFailure` to `false`).
- To reduce blast radius while the flag stays on: lower
  `PRODUCT_CATALOG_FAILURE_PERCENT` (env var, default `100`) — e.g. `10` injects
  errors on only 10 % of calls to the targeted SKUs.
- To narrow the targeted SKUs: edit `failingProductIDs` in `main.go` to remove
  high-traffic entries.

---

### 2 — Product-not-found NOT_FOUND on `GetProduct` (~18 % of all errors)

| Attribute | Value |
|---|---|
| gRPC status code | `5` (NOT_FOUND) |
| `otel.span.status.message` | `Product Id Not Found: ZFYYMZ29E6` |
| `app.product.id` | `ZFYYMZ29E6` |
| Correlation coefficient vs all errors | **+18 %** |
| Exemplar trace | `3864f3ac08493ff06618ecc6775e8c32` span `c4d412829adef060` |

**Cause:** The product ID `ZFYYMZ29E6` is requested by callers (load-generator
or frontend) but does not exist in the product catalog DB. `GetProduct` returns
`codes.NotFound` after failing the DB lookup. This is not caused by the feature
flag — the span has no `featureflagservice` child, confirming the NOT_FOUND path
is reached directly.

`ZFYYMZ29E6` is **not** in the `failingProductIDs` set, confirming this is a
genuine missing-product scenario, not injected failure.

**How to remediate:**
- Verify whether `ZFYYMZ29E6` should exist in the DB. If deleted, restore it or
  remove it from the load generator's product ID pool.
- If this is load-generator churn: update `src/load-generator` to only request
  product IDs present in the seed data.

---

## Downstream impact

| Caller | Errors from productcatalogservice | Total calls | Impact |
|---|---|---|---|
| `frontend` | 131 | 9 708 | 1.35 % error rate on product pages |
| `checkoutservice` | 2 | 234 | < 1 % |
| `recommendationservice` | 0 | 1 622 | None (uses `ListProducts`, not `GetProduct`) |

The `ListProducts` operation (2 307 calls) has **0 % errors** — only `GetProduct`
is affected.

---

## Span-level evidence

```
# Error 1 — INTERNAL (feature flag)
traceId:  fa67addd05b55310c18d747c57c8a527
spanId:   237a00fce96a4f11
status:   ERROR  |  gRPC 13 (INTERNAL)
message:  "Product Id Lookup Failed: OLJCESPC7Z"
child:    oteldemo.FeatureFlagService/EvaluateProbabilityFeatureFlag → UNSET (flag returned true)

# Error 2 — NOT_FOUND (missing product)
traceId:  3864f3ac08493ff06618ecc6775e8c32
spanId:   c4d412829adef060
status:   ERROR  |  gRPC 5 (NOT_FOUND)
message:  "Product Id Not Found: ZFYYMZ29E6"
child:    (none — DB lookup failed, no feature-flag call)
```

---

## Relevant source locations

| File | What to change |
|---|---|
| `src/product-catalog/main.go` — `failingProductIDs` | Add/remove SKUs subject to failure injection |
| `src/product-catalog/main.go` — env `PRODUCT_CATALOG_FAILURE_PERCENT` | Reduce injection rate below 100 % |
| `src/flagd/demo.flagd.json` | Toggle `productCatalogFailure` flag on/off |
| `src/load-generator/...` | Remove `ZFYYMZ29E6` from product ID pool if absent from DB seed data |
