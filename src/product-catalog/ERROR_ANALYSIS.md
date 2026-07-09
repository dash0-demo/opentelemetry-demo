# productcatalogservice — Error Analysis Report

**Analysed window:** 2026-07-09T08:17–08:47 CEST (30 min)  
**Observed by:** Agent0 / Dash0

---

## Summary

All errors in `productcatalogservice` are on a single operation:
`oteldemo.ProductCatalogService/GetProduct` (gRPC SERVER spans).

- **Total `GetProduct` calls:** 9 128 (9 016 OK/UNSET + 112 ERROR)
- **Error rate:** ~1.2 %

---

## Error patterns (highest-impact first)

### 1 — `productCatalogFailure` feature-flag fault injection (84 errors, ~75 % of errors)

| Field | Value |
|-------|-------|
| Span status message | `Product Id Lookup Failed: OLJCESPC7Z` |
| Span event | `Product Id Lookup Failed: OLJCESPC7Z` |
| gRPC status code | `13` (INTERNAL) |
| `app.product.id` | `OLJCESPC7Z` |
| Span duration | ~3 ms (hits DB + flagd evaluation) |
| Upstream impact | `frontend` HTTP GET spans also set ERROR status |

**Cause:** The `productCatalogFailure` OpenFeature flag is **enabled** in the running flagd
instance. `checkProductFailure()` (`main.go:547`) evaluates the flag for each request whose
product ID is in `failingProductIDs` (lines 513–519). When the flag returns `true` the handler
returns `codes.Internal` and marks the span ERROR.

The hardcoded `failingProductIDs` set contains five SKUs:

```
OLJCESPC7Z  National Park Foundation Explorascope 60mm
L9ECAV7KIM  Terrarium
6E92ZMYYFZ  Optical Tube Assembly
9SIQT8TOJO  Solar System Color Imager
HQTGWGPNH4  Solar Filter
```

Only `OLJCESPC7Z` appeared in the sampled error window, but all five are equally susceptible.

**Discrepancy between code and telemetry:**
The source (`main.go:467–469`) sets the status message to
`"Error: Product Catalog Fail Feature Flag Enabled"` with no product ID.
The live telemetry carries `"Product Id Lookup Failed: OLJCESPC7Z"` — a different message
that includes the product ID. The running service binary does not match the current source code
for this error path.

**Fix options:**
- Disable the `productCatalogFailure` flag in flagd to stop fault injection in production/staging.
- Set `PRODUCT_CATALOG_FAILURE_PERCENT` env var to a value < 100 to reduce the injection rate.
- Align the span status message in `main.go:467` with what the telemetry actually emits, so
  dashboards and alerts can filter on a stable string.

---

### 2 — Product ID not found in database (28 errors, ~25 % of errors)

| Field | Value |
|-------|-------|
| Span status message | `Product Id Not Found: ZFYYMZ29E6` |
| Span event | `Product Id Not Found: ZFYYMZ29E6` |
| gRPC status code | `5` (NOT_FOUND) |
| `app.product.id` | `ZFYYMZ29E6` |
| Span duration | ~70–100 µs (fast rejection, no DB hit or flagd call) |
| Span children | none |

**Cause:** `getProductFromDB()` returns `sql.ErrNoRows` for product ID `ZFYYMZ29E6`, which
is not present in the `catalog.products` table. The handler (`main.go:473–477`) returns
`codes.NotFound`.

The very short span duration (< 0.1 ms, no children) is consistent with an early DB miss — the
row does not exist and no flagd evaluation takes place.

**Discrepancy between code and telemetry:**
The source (`main.go:474`) sets the status message to `"Product Not Found: <id>"`.
The live telemetry carries `"Product Id Not Found: ZFYYMZ29E6"` — "Id" is inserted between
"Product" and "Not Found". Again the running binary does not match the current source.

**Fix options:**
- Verify that the `catalog.products` table contains all valid SKUs; run a migration if `ZFYYMZ29E6`
  is a legitimate product that is simply missing from the DB.
- If `ZFYYMZ29E6` is an invalid SKU sent by a caller, add input validation upstream in `frontend`
  before the gRPC call is dispatched.

---

## Attribute inconsistency: `demo.product.id` vs `app.product.id`

The source code (`main.go:461`, `main.go:480`) sets the attribute key `demo.product.id`.
All error spans in Dash0 carry the attribute as `app.product.id`.

This suggests the deployed image was built from a different version of the source than what
is in the repository's default branch. Any dashboards or alert rules filtering on `demo.product.id`
will miss these spans.

**Recommendation:** Confirm which image tag is deployed and ensure it matches the source revision
in this repository before shipping further instrumentation changes.

---

## Impact chain

Both error types propagate up the call stack:

```
frontend  HTTP GET  (ERROR)
  └── frontend  grpc.oteldemo.ProductCatalogService/GetProduct  CLIENT  (ERROR)
        └── productcatalogservice  GetProduct  SERVER  (ERROR)   ← origin
              └── productcatalogservice  FeatureFlagService/EvaluateProbabilityFeatureFlag  CLIENT  (pattern 1 only)
```

The frontend's top-level HTTP GET span is also marked ERROR, meaning these failures are directly
user-visible.

---

## Recommended next steps (priority order)

1. **Disable `productCatalogFailure` flag** if fault injection is not intentional in the current
   environment. This eliminates ~75 % of errors immediately.
2. **Investigate `ZFYYMZ29E6`** — determine whether it is a missing DB row or an invalid caller
   input. Query `SELECT * FROM catalog.products WHERE id = 'ZFYYMZ29E6'` to confirm.
3. **Reconcile the deployed image** with the source code to resolve the `app.product.id` /
   `demo.product.id` attribute key mismatch and the span status message differences.
4. **Add an alert** on `GetProduct` error rate > 1 % sustained over 5 minutes to catch future
   regressions before they accumulate.
