# productcatalogservice — Error Analysis

> Observed window: 2026-07-13 07:16–07:46 UTC  
> Service: `productcatalogservice` (namespace: `opentelemetry-demo`)  
> Overall error rate: **0.98 %** of 11 112 requests  
> Operation affected: `GetProduct` only (1.22 % error rate on that operation; `ListProducts` has 0 %)

---

## Error 1 — Feature-Flag Injection (gRPC INTERNAL / status 13) — ~79 % of errors

### Observed behaviour

`GetProduct` requests for product `OLJCESPC7Z` fail with gRPC status `13 INTERNAL`
and a span event named `"Product Id Lookup Failed: OLJCESPC7Z"`.

Example span: trace `481c970d8167e46a79f32f61714d6913`, span `886ac78e400dca58`.

### Root cause

The `productCatalogFailure` OpenFeature flag is **enabled** in the running environment.
When the flag is on, `checkProductFailure` (`main.go:561`) returns `true` for every
product ID in `failingProductIDs`, which currently contains:

```
OLJCESPC7Z  (National Park Foundation Explorascope 60mm)
L9ECAV7KIM  (Terrarium)
6E92ZMYYFZ  (Optical Tube Assembly)
9SIQT8TOJO  (Solar System Color Imager)
HQTGWGPNH4  (Solar Filter)
```

Because the frontend queries `OLJCESPC7Z` by far the most frequently, that SKU
dominates the error count. `GetProduct` short-circuits at `main.go:481–483` and
returns `codes.Internal` with message `"Error: Product Catalog Fail Feature Flag Enabled"`.

### Impact

- Triggers the active failed check: **"Product Catalog returns > 0.6 % errors"**
  (firing since 2026-07-13 06:14 UTC).
- Every `frontend` page load that renders this product returns an HTTP error to
  the end user. Downstream call count from `frontend` to `productcatalogservice`
  shows 104 errors / 9 093 calls in the same window.
- `checkoutservice` is also affected (1 error / 219 calls).

### Remediation

Disable the `productCatalogFailure` feature flag in the flagd configuration for
the relevant environment. The flag defaults to `false` (`flags.json`); it was
turned on deliberately for demo/chaos purposes but is now violating the SLO.

Optionally, tune `PRODUCT_CATALOG_FAILURE_PERCENT` (env var, defaults to 100) to
reduce the failure rate without fully disabling the flag.

---

## Error 2 — Unknown Product ID in Database (gRPC NOT_FOUND / status 5) — ~20 % of errors

### Observed behaviour

`GetProduct` requests for product `ZFYYMZ29E6` fail with gRPC status `5 NOT_FOUND`
and a span event named `"Product Id Not Found: ZFYYMZ29E6"`.

Example span: trace `d80b014aa5a45e3bfdcd9100cf31f92e`, span `132d599aca150145`.

### Root cause

The product ID `ZFYYMZ29E6` is **not** in `failingProductIDs` (no feature-flag
involvement), and the database query at `main.go:352–358` returns `sql.ErrNoRows`
for it. The `getProductFromDB` helper surfaces this as `fmt.Errorf("product not found")`
which the gRPC handler converts to `codes.NotFound` (`main.go:488–491`).

The product does not exist in the `catalog.products` table. The frontend or a
recommendation is requesting a SKU that was never seeded, or was deleted.

### Remediation

1. Verify whether `ZFYYMZ29E6` should exist in the product catalog database. If
   so, add the missing row to the seed data / migration.
2. If this ID is no longer valid, remove it from any static recommendation lists
   or frontend configuration that references it.
3. Consider returning a structured gRPC error metadata field (`productId`) so
   callers can distinguish "product missing" from other 5xx errors without
   parsing the message string.

---

## Duration profile

| Error type        | gRPC status | Typical duration | Duration explanation |
|:------------------|:------------|:-----------------|:---------------------|
| Feature flag      | 13 INTERNAL | ~3 ms            | Calls flagd (`EvaluateProbabilityFeatureFlag`) before returning error |
| Product not found | 5 NOT_FOUND | ~0.1 ms          | DB query returns immediately with no rows; no flagd call |

The 3 ms vs 0.1 ms split is diagnostic: feature-flag errors include a child span
to `featureflagservice` for flag evaluation; NOT_FOUND errors do not.

---

## Downstream impact summary

| Caller service         | Errors (30 min) | Total calls | Error rate |
|:-----------------------|----------------:|------------:|-----------:|
| `frontend`             | 104             | 9 093       | 1.14 %     |
| `checkoutservice`      | 1               | 219         | 0.46 %     |
| `recommendationservice`| 0               | 1 566       | 0 %        |
