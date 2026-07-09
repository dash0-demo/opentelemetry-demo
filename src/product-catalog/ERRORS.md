# productcatalogservice — Error Analysis (2026-07-09)

Observed window: **2026-07-09 05:57–06:27 UTC** (30 min)  
Service health: **critical** — overall error rate **1.13 %** (active alert threshold: 0.6 %)  
Total requests analysed: **11 326**  
Affected operation: `oteldemo.ProductCatalogService/GetProduct` (9 102 calls, **1.41 %** error rate)

---

## Error 1 — Feature-flag failure injection (highest impact)

| Attribute | Value |
|---|---|
| `app.product.id` | `OLJCESPC7Z` (National Park Foundation Explorascope 60mm) |
| `otel.span.status.message` | `Product Id Lookup Failed: OLJCESPC7Z` |
| gRPC status code | `13` (INTERNAL) |
| Span duration | ~3 ms |
| Propagated to | `frontend` HTTP 500 — callers see a 500 on the checkout/product page |
| Mechanism | `productCatalogFailure` feature flag (via flagd) is **enabled**. `checkProductFailure()` matches `OLJCESPC7Z` against `failingProductIDs` and returns a gRPC INTERNAL error. |

### Impact
Every `GetProduct` call for this SKU fails with INTERNAL, propagating an HTTP 500 to the `frontend`. The `frontend` service is currently marked **critical**.

### Root cause in code (`main.go:466-470`)
```go
if p.checkProductFailure(ctx, req.Id) {
    msg := "Error: Product Catalog Fail Feature Flag Enabled"
    span.SetStatus(otelcodes.Error, msg)
    return nil, status.Error(codes.Internal, msg)
}
```
The `productCatalogFailure` flag controls five SKUs (see `failingProductIDs`). The failure rate is controlled by the `PRODUCT_CATALOG_FAILURE_PERCENT` env var (defaults to 100 when unset).

### Fix options
1. **Disable the flag** in flagd (zero-downtime, no deploy): set `productCatalogFailure` to `false` in the flagd configuration or via the flagd-ui.
2. **Reduce failure percent**: set `PRODUCT_CATALOG_FAILURE_PERCENT` to a lower value (e.g. `10`) to reduce the blast radius while the flag remains on for demo purposes.

---

## Error 2 — Unknown product ID requested (lower impact)

| Attribute | Value |
|---|---|
| `app.product.id` | `ZFYYMZ29E6` |
| `otel.span.status.message` | `Product Id Not Found: ZFYYMZ29E6` |
| gRPC status code | `5` (NOT_FOUND) |
| Span duration | ~0.1–0.2 ms (fast fail — no DB row matched) |
| Propagated to | `frontend` (gRPC client span also set to ERROR) |

### Root cause in code (`main.go:472-477`)
```go
found, err := getProductFromDB(ctx, req.Id)
if err != nil {
    msg := fmt.Sprintf("Product Not Found: %s", req.Id)
    span.SetStatus(otelcodes.Error, msg)
    return nil, status.Error(codes.NotFound, msg)
}
```
`ZFYYMZ29E6` is not in the `failingProductIDs` set, so the feature flag path is not reached. The product does not exist in the PostgreSQL `catalog.products` table.

### Fix options
1. **Identify the caller**: trace spans show `frontend` is the direct caller. Investigate which frontend page/flow references this product ID (it may be a stale ID in a hardcoded recommendation, test scenario, or load-generator script).
2. **Add the product to the DB**: if the SKU should exist, insert it in the `catalog.products` table.
3. **Harden error handling in the caller**: `frontend` could gracefully degrade (show "product unavailable") instead of propagating a 500.

---

## Observability notes

### Attribute key inconsistency
`main.go` sets `demo.product.id` on the span (lines 461, 481) but telemetry surfaces as `app.product.id`. This is consistent with the OTel collector remapping `demo.*` → `app.*` attributes. Both names refer to the same field; no code change is needed, but documentation should note the mapping.

### `rpc.grpc.status_code` vs span status
- Feature-flag path returns gRPC code `13` (INTERNAL).
- Not-found path returns gRPC code `5` (NOT_FOUND).
These codes are correctly reflected in `rpc.grpc.status_code` and can be used as PromQL filters (`rpc_grpc_status_code`) when building alerts.

---

## Active alert
`Product Catalog returns > 0.6% errors` (identifier `13425276024699803080`) has been firing since `2026-07-09T00:30:15Z`. It will auto-resolve once the error rate drops below 0.6 % — which requires either disabling `productCatalogFailure` or reducing `PRODUCT_CATALOG_FAILURE_PERCENT`.
