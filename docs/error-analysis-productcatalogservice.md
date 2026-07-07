# Error Analysis: productcatalogservice

**Service:** `productcatalogservice` (namespace: `opentelemetry-demo`)  
**Analysis window:** 2026-07-07 11:47–12:17 UTC (30 minutes)  
**Total error spans observed:** 119 out of 12,739 GetProduct calls (~0.9% error rate)

---

## Error Pattern 1 — Intentional Feature Flag Failure (gRPC INTERNAL / code 13)

**Frequency:** ~81% of all error spans  
**Impact:** High — every occurrence returns gRPC status `INTERNAL (13)` to callers, causing `frontend` to propagate an HTTP error to end users  
**Affected operation:** `oteldemo.ProductCatalogService/GetProduct`  
**Affected product ID:** `OLJCESPC7Z` (74% correlation with error status)

### Root cause

The `productCatalogFailure` feature flag (evaluated via flagd / OpenFeature) is enabled for product ID `OLJCESPC7Z`. When the flag evaluates to `true`, `checkProductFailure()` returns immediately with `codes.Internal` before the database lookup is attempted. This is intentional demo chaos injection.

**Relevant code path (`src/product-catalog/main.go`, line 370–375):**

```go
if p.checkProductFailure(ctx, req.Id) {
    msg := "Error: Product Catalog Fail Feature Flag Enabled"
    span.SetStatus(otelcodes.Error, msg)
    span.AddEvent(msg)
    return nil, status.Error(codes.Internal, msg)
}
```

**Observed span event in telemetry:** `Product Id Lookup Failed: OLJCESPC7Z`  
**Observed status message:** `Product Id Lookup Failed: OLJCESPC7Z`

> Note: the span event name seen in live telemetry (`Product Id Lookup Failed: OLJCESPC7Z`) does not match what the current source emits (`Error: Product Catalog Fail Feature Flag Enabled`). This indicates the running pod is executing a **different binary version** than what is currently in the `main` branch. The span event naming convention should be unified between the running service and the current codebase.

### Trace evidence

- Trace: `5cbb21f3304586e4d0b15d7804baedc8`
- Span: `aab4e3c155fe1839`
- Caller: `frontend` → gRPC CLIENT span `236d32f6a516ef97` → propagated as HTTP ERROR to root span `bb81909d1ecd5332`
- Child span `oteldemo.FeatureFlagService/EvaluateProbabilityFeatureFlag` confirms flag evaluation takes place before the failure is returned

### Recommendation

- The feature flag controls demo chaos injection; this is expected behavior. Consider:
  1. **Documenting** the flag and its effect in the service README so operators understand this is intentional.
  2. **Updating span event names** in the running service to match the current source code (`Error: Product Catalog Fail Feature Flag Enabled`) to avoid confusion during incident investigation.
  3. Adding a structured span attribute (e.g. `app.failure.reason = "feature_flag"`) to make it easier to filter intentional chaos errors from real errors in dashboards and alerts.

---

## Error Pattern 2 — Product Not Found (gRPC NOT_FOUND / code 5)

**Frequency:** ~19% of all error spans  
**Impact:** Medium — returns gRPC `NOT_FOUND (5)` to callers; the frontend propagates this as an error  
**Affected operation:** `oteldemo.ProductCatalogService/GetProduct`  
**Affected product ID:** `ZFYYMZ29E6` (19% correlation with error status)

### Root cause

A `GetProduct` request is made with product ID `ZFYYMZ29E6`, which does not exist in the database. The service queries PostgreSQL, receives `sql.ErrNoRows`, and returns `codes.NotFound`.

**Relevant code path (`src/product-catalog/main.go`, line 378–383):**

```go
found, err := getProductFromDB(ctx, req.Id)
if err != nil {
    msg := fmt.Sprintf("Product Not Found: %s", req.Id)
    span.SetStatus(otelcodes.Error, msg)
    span.AddEvent(msg)
    return nil, status.Error(codes.NotFound, msg)
}
```

**Observed span event in telemetry:** `Product Id Not Found: ZFYYMZ29E6`

> Same version mismatch note as above — the live event name (`Product Id Not Found`) differs from source (`Product Not Found`).

### Trace evidence

- Trace: `7ce49a45006a9849c1ea9d7aaf4cd8dd`
- Span: `3f7deac54354ed36`
- Duration: ~80µs (extremely fast — confirms it reaches the DB lookup but returns immediately on miss)
- No children — the DB call completes inline with no traced child span
- Caller: `frontend` gRPC CLIENT span `6c4b4205b486ceef`

### Recommendation

- The product ID `ZFYYMZ29E6` appears to be a synthetic / test ID injected by the load generator (not a real catalog product). This is expected demo behavior.
- Consider adding a structured span attribute `app.failure.reason = "product_not_found"` for the same filtering benefit as above.
- If these NOT_FOUND calls are not intentional load-generator traffic, investigate whether the load generator's product ID list is out of sync with the catalog.

---

## Impact Summary

| Error Pattern | gRPC Code | % of Errors | Caller Impact | Intentional? |
|---|---|---|---|---|
| Feature flag chaos (product `OLJCESPC7Z`) | 13 INTERNAL | ~81% | `frontend` HTTP errors surfaced to users | Yes (demo feature) |
| Missing product (ID `ZFYYMZ29E6`) | 5 NOT_FOUND | ~19% | `frontend` HTTP errors surfaced to users | Yes (load generator) |

Both error patterns originate from `GetProduct` only — `ListProducts` and `SearchProducts` show no error correlation in the same window.

---

## Observability Gaps

1. **Version skew in span event names:** Running binary emits `Product Id Lookup Failed` / `Product Id Not Found`; current source emits different strings. Any alert or dashboard that filters on the event name string will break when the deployment is updated.
2. **No structured `app.failure.reason` attribute:** Differentiating intentional chaos errors from real errors currently requires reading the status message string, which is fragile.
3. **No alert distinguishing chaos vs. real errors:** A single error-rate alert on this service will fire for both feature-flag-injected and genuine failures without a way to suppress known-good chaos traffic.
