# Product Catalog Service — Error Analysis

**Service:** `productcatalogservice` (namespace: `opentelemetry-demo`)
**Time window:** last 30 minutes (2026-07-10)
**Overall error rate:** 1.05 % of 11,144 requests — triggers the "Product Catalog returns > 0.6% errors" Check Rule.

---

## Highest-Impact Error: Feature-Flag Error Injection on GetProduct

### Cause
The `productCatalogFailure` feature flag (evaluated via flagd) is **enabled**.
When the flag is on, `GetProduct` returns `codes.Internal` for requests targeting
any of the five hardcoded failing SKUs:

| SKU          | Product name                           |
|:-------------|:---------------------------------------|
| OLJCESPC7Z   | National Park Foundation Explorascope 60mm |
| L9ECAV7KIM   | Terrarium                              |
| 6E92ZMYYFZ   | Optical Tube Assembly                  |
| 9SIQT8TOJO   | Solar System Color Imager              |
| HQTGWGPNH4   | Solar Filter                           |

SKUs observed in error spans during the analysis window: **OLJCESPC7Z**, **ZFYYMZ29E6**.

### Span evidence
- Operation: `oteldemo.ProductCatalogService/GetProduct` (SERVER span, gRPC)
- `otel.span.status.code`: `ERROR`
- gRPC status code: **13** (`INTERNAL`)
- Span event: `Product Id Lookup Failed: <SKU>`
- Call depth: errors propagate up through `checkoutservice/PlaceOrder` →
  `frontend` (HTTP POST), marking the entire checkout trace as ERROR.

### Operation error rates (last 30 min)
| Operation      | Error rate | Request count |
|:---------------|:----------:|:-------------:|
| GetProduct     | 1.30 %     | 8,968         |
| ListProducts   | 0.00 %     | 2,176         |

`ListProducts` is unaffected — the feature flag only targets `GetProduct`.

### Downstream impact
Three callers received errors propagated from this service:

| Caller              | Errors to this service |
|:--------------------|:----------------------:|
| frontend            | 115 errors / 9,295 req |
| checkoutservice     | ~0 errors / 202 req    |
| recommendationservice | 0 errors / 1,519 req |

Checkout and frontend are both marked `critical` health in the service map.

### Two error sub-patterns

1. **Feature-flag fast-fail** (no child spans, duration < 0.1 ms):
   flagd evaluation returns `true` before any DB call; `checkProductFailure`
   returns immediately with `codes.Internal`.

2. **Feature-flag fail after flagd call** (has `EvaluateProbabilityFeatureFlag`
   child span, duration ~3 ms):
   flagd is called over gRPC, resolves the flag, and the failure is injected
   after the network round-trip.

### Code location
`src/product-catalog/main.go` — `checkProductFailure()` (line 561) and
`GetProduct()` (line 458).
The `failingProductIDs` map (line 527) controls which SKUs are targeted.
The `PRODUCT_CATALOG_FAILURE_PERCENT` env var (default 100) controls the
fraction of targeted requests that actually fail.

### Resolution
Disable the `productCatalogFailure` feature flag in flagd (see
`src/flagd/demo.flagd.json`) or set `PRODUCT_CATALOG_FAILURE_PERCENT=0`
on the deployment to suppress errors without changing the flag state.
