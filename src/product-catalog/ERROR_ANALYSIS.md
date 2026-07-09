# productcatalogservice Error Analysis

> Analyzed window: 2026-07-09 07:15 UTC – 07:45 UTC (30 minutes)
> Service health: **critical** — 1.14 % error rate across 11 272 requests
> Active alert: `Product Catalog returns > 0.6% errors`

## Error summary

| # | Error type | gRPC code | Count (30 min sample) | Relative weight | Affected operation |
|---|-----------|-----------|----------------------|-----------------|-------------------|
| 1 | `Product Id Lookup Failed` (feature-flag injection) | 13 INTERNAL | ~85 % of errors | High | `GetProduct` |
| 2 | `Product Id Not Found` (unknown product ID in DB) | 5 NOT_FOUND | ~15 % of errors | Medium | `GetProduct` |

Both error types are limited to `GetProduct`. `ListProducts` and `SearchProducts` show zero errors in the same window.

---

## Error 1 — Feature-flag–induced failure injection (INTERNAL / gRPC 13)

### What happens

`checkProductFailure` in `main.go` (line 547) checks two conditions before returning `true`:

1. The requested product ID is in `failingProductIDs` (five hardcoded SKUs).
2. The `productCatalogFailure` feature flag is evaluated as `true` by flagd.

When both conditions are met the span status is set to ERROR with message  
`"Error: Product Catalog Fail Feature Flag Enabled"` and gRPC `codes.Internal` (13) is returned.

### Trigger chain observed in traces

```
OtelSqsDebuggerLambda (ERROR)
  └─ frontend GET (ERROR)
       └─ frontend → productcatalogservice GetProduct CLIENT (ERROR)
            └─ productcatalogservice GetProduct SERVER (ERROR)  ← error here
                 └─ FeatureFlagService EvaluateProbabilityFeatureFlag CLIENT (UNSET)
```

The feature-flag call *succeeds* (UNSET = OK); the error is a deliberate outcome returned by flagd based on the flag's configured probability. The affected SKU observed is `OLJCESPC7Z` (National Park Foundation Explorascope 60mm). The five targeted SKUs are:

- `OLJCESPC7Z`
- `L9ECAV7KIM`
- `6E92ZMYYFZ`
- `9SIQT8TOJO`
- `HQTGWGPNH4`

### Impact

- All callers of `GetProduct` for the above SKUs receive `codes.Internal`.
- The frontend and checkout services both surface these as HTTP 500 responses.
- The error rate (1.41 % on GetProduct) is high enough to breach the 0.6 % alert threshold.
- Because the error is intentional demo behavior, this is expected when the flag is on; the alert fires by design.

### Remediation options

| Option | Effect |
|--------|--------|
| Disable the `productCatalogFailure` feature flag in flagd | Errors stop immediately |
| Set env var `PRODUCT_CATALOG_FAILURE_PERCENT=0` | Errors stop even if flag is on |
| Reduce `PRODUCT_CATALOG_FAILURE_PERCENT` (e.g., 10) | Lowers rate; alert may still fire |

---

## Error 2 — Product ID not found in database (NOT_FOUND / gRPC 5)

### What happens

`getProductFromDB` (line 346) queries PostgreSQL for the requested product ID.  
When the row is absent (`sql.ErrNoRows`), it returns `fmt.Errorf("product not found")`.  
`GetProduct` catches any error from `getProductFromDB` and returns gRPC `codes.NotFound` (5)  
with message `"Product Not Found: <id>"`.

Representative failing IDs observed: `ZFYYMZ29E6`, and others not in `failingProductIDs`.  
These spans complete very quickly (60–200 µs) — consistent with a fast DB miss — with no child spans,  
meaning the feature-flag path was not taken and the DB returned no row.

### Trigger chain observed in traces

```
frontend HTTP GET (ERROR)
  └─ frontend → productcatalogservice GetProduct CLIENT (ERROR)
       └─ productcatalogservice GetProduct SERVER (ERROR)  ← DB miss, no children
```

### Impact

- Lower frequency than Error 1 but still contributes to the overall error rate.
- Each caller receives `codes.NotFound`, which the frontend maps to a 404-class response.
- These errors suggest callers are requesting product IDs that do not exist in the `catalog.products` table.

### Remediation options

| Option | Effect |
|--------|--------|
| Audit product IDs passed by recommendation/checkout services against the DB catalog | Eliminate stale references |
| Add a startup consistency check that validates the demo's hardcoded product list against the DB | Catch catalog drift at deploy time |
| Log the full product ID to an `app.product.id` span attribute on errors | Already implemented (attribute present on spans) — no change needed |

---

## Downstream impact

| Dependent service | Errors from productcatalogservice (30 min) |
|------------------|--------------------------------------------|
| frontend | 121 |
| checkoutservice | 1 |
| recommendationservice | 0 (no errors attributed) |

The `frontend` service bears the highest customer-facing impact from these errors.

---

## Code references

- Error 1 injection: `src/product-catalog/main.go` lines 458–470 (`GetProduct`), 547–561 (`checkProductFailure`)
- Failing SKU set: `src/product-catalog/main.go` lines 513–519 (`failingProductIDs`)
- Failure percent config: `src/product-catalog/main.go` lines 527–545 (`readFailurePercentFromEnv`)
- Error 2 — DB not-found path: `src/product-catalog/main.go` lines 346–371 (`getProductFromDB`)

Assisted-by: Claude Sonnet 4.6
