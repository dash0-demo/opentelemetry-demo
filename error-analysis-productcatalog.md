# Error Analysis: productcatalogservice

**Service:** `productcatalogservice` (namespace: `opentelemetry-demo`)
**Time range:** 2026-07-16 05:34 – 06:04 UTC (last 30 minutes)

---

## Summary

Two active, distinct error patterns were observed in the `opentelemetry-demo` namespace during the analysis window. Both are caused by intentional fault-injection mechanisms (feature flags), but they have different severity profiles.

---

## Error 1 (Highest Impact): `productcatalogservice` — GetProduct feature-flag failure

### Description

`oteldemo.ProductCatalogService/GetProduct` is returning `gRPC INTERNAL` errors for a hardcoded set of product SKUs when the `productCatalogFailure` feature flag is enabled.

### Root cause

The flag `productCatalogFailure` is currently ON. When enabled, `GetProduct` calls for any of the following SKUs are deliberately failed at a rate controlled by `PRODUCT_CATALOG_FAILURE_PERCENT` (defaults to 100 % when unset):

| SKU | Product |
|---|---|
| `OLJCESPC7Z` | National Park Foundation Explorascope 60mm |
| `L9ECAV7KIM` | Terrarium |
| `6E92ZMYYFZ` | Optical Tube Assembly |
| `9SIQT8TOJO` | Solar System Color Imager |
| `HQTGWGPNH4` | Solar Filter |

The span event recorded is `Product Id Lookup Failed: <SKU>`, and `otel.span.status.code = ERROR` propagates to the calling `frontend` span (`HTTP GET`), resulting in HTTP 500s visible to users.

### Observed evidence

- Span status message: `Product Id Lookup Failed: OLJCESPC7Z`
- 50+ ERROR spans in the 30-minute window, one every ~30 s, continuous throughout the window
- All errors on a single operation (`GetProduct`) and a single pod (`opentelemetry-demo-productcatalogservice-7f464fd7d8-qbpdw`)
- Upstream impact: parent `frontend` spans (`HTTP GET`) also carry `ERROR` status with 2 error descendants each
- `app.product.id` values observed in error spans include all 5 failing SKUs

### Affected code path

[`src/product-catalog/main.go` — `checkProductFailure`](https://github.com/dash0-demo/opentelemetry-demo/blob/main/src/product-catalog/main.go#L560-L574)

```go
func (p *productCatalog) checkProductFailure(ctx context.Context, id string) bool {
    if _, targeted := failingProductIDs[id]; !targeted {
        return false
    }
    if !flags.ProductCatalogFailure.Value(...) {
        return false
    }
    // returns true → caller sets span ERROR and returns codes.Internal
}
```

### Remediation options

1. **Disable the `productCatalogFailure` feature flag** via flagd/flagd-ui — immediately stops all injected errors.
2. **Reduce the failure rate** by setting `PRODUCT_CATALOG_FAILURE_PERCENT` < 100 in the deployment env.
3. If the flag should remain on for demo purposes, add a metric-based alert on `productcatalogservice` error rate to make the injection window visible to operators.

---

## Error 2: `adservice` — GetAds RESOURCE_EXHAUSTED

### Description

`oteldemo.AdService/GetAds` is returning `gRPC RESOURCE_EXHAUSTED` (status code 8) errors.

### Root cause

The span event `Error` carries `exception.message: "RESOURCE_EXHAUSTED"`. The `rpc.grpc.status_code = 8` attribute is present on ~30 % of `GetAds` spans in the error subset. This is a separate feature-flag-driven fault injection in `adservice` — the `EvaluateProbabilityFeatureFlag` child span is present on all error traces, confirming the error is gated by a feature flag evaluation.

### Observed evidence

- 50+ ERROR spans in the 30-minute window across 3 pods (`7bc574b9f9-5wcg2`, `7bc574b9f9-vmnn5`, `7bc574b9f9-njjh4`)
- Each error span carries 2 events: `message` (RECEIVED) and `Error` (`exception.message: RESOURCE_EXHAUSTED`)
- `grpc.error_message = "8 RESOURCE_EXHAUSTED: "` present in correlation analysis
- Upstream impact: parent `frontend` `grpc.oteldemo.AdService/GetAds` CLIENT spans and root `HTTP GET` spans also carry `ERROR`

### Remediation options

1. Disable the adservice fault-injection feature flag in flagd-ui.
2. If intentional, ensure load-testing scenarios are time-bounded and observable via an alert.

---

## Impact summary

| Error | Service | Operation | gRPC status | Observed errors (30 min) | User-visible |
|---|---|---|---|---|---|
| Feature-flag product failure | `productcatalogservice` | `GetProduct` | INTERNAL (13) | 50+ | Yes — HTTP 500 on product pages |
| Feature-flag ad exhaustion | `adservice` | `GetAds` | RESOURCE_EXHAUSTED (8) | 50+ | Yes — ad section fails on product pages |

Both errors surface as `HTTP 500` in the `frontend` service and degrade the product-detail page experience. The product-catalog failure is the higher-severity issue because it blocks the primary product content (not just ads).

---

*Analysis performed by Agent0 on 2026-07-16 using Dash0 observability data.*
