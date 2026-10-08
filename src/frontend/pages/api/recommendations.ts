// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import { context, Span, trace } from '@opentelemetry/api';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import logger from '../../utils/telemetry/logger';
import RecommendationsGateway from '../../gateways/rpc/Recommendations.gateway';
import { Empty, Product } from '../../protos/demo';
import ProductCatalogService from '../../services/ProductCatalog.service';

type TResponse = Product[] | Empty;

const RECOMMENDATION_COUNT = 4;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const { productIds = [], sessionId = '', currencyCode = '' } = query;
      const { productIds: productList } = await RecommendationsGateway.listRecommendations(
        sessionId as string,
        productIds as string[]
      );

      const requestedIds = productList.slice(0, RECOMMENDATION_COUNT);

      // Fetch each recommended product independently. `Promise.allSettled` is
      // deliberate: `Promise.all` fails fast, so a single GetProduct error
      // (e.g. the productCatalogFailure fault injection, or one SKU missing
      // from the catalog) rejected the whole batch and the instrumentation
      // middleware turned it into an HTTP 500 — discarding the lookups that
      // did succeed. A recommendation carousel is a best-effort surface, so a
      // partial list is strictly better than no page at all.
      const results = await Promise.allSettled(
        requestedIds.map(id => ProductCatalogService.getProduct(id, currencyCode as string))
      );

      const recommendedProductList = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected' ? [{ productId: requestedIds[index], error: result.reason as Error }] : []
      );

      // Dropping a recommendation silently would trade a loud 500 for an
      // invisible gap, so record what was lost on the span and in the log
      // stream. The span status stays untouched: a degraded carousel is not a
      // request failure, and marking it ERROR would keep this endpoint's error
      // rate pinned to the catalog's fault-injection rate.
      if (failures.length > 0) {
        const span = trace.getSpan(context.active()) as Span | undefined;
        const failedIds = failures.map(({ productId }) => productId);

        span?.setAttributes({
          'app.recommendations.requested_count': requestedIds.length,
          'app.recommendations.returned_count': recommendedProductList.length,
          'app.recommendations.failed_count': failures.length,
          'app.recommendations.failed_product_ids': failedIds,
        });

        failures.forEach(({ productId, error }) => {
          span?.addEvent('recommendation.product_lookup_failed', {
            'app.product.id': productId,
            'exception.message': error?.message ?? 'unknown error',
          });
        });

        const spanCtx = span?.spanContext();
        logger.warn(
          {
            'app.recommendations.requested_count': requestedIds.length,
            'app.recommendations.returned_count': recommendedProductList.length,
            'app.recommendations.failed_product_ids': failedIds,
            err: failures[0].error,
            trace_id: spanCtx?.traceId,
            span_id: spanCtx?.spanId,
          },
          'recommendations.partial_result'
        );
      }

      // Every lookup failing means the catalog is unusable rather than flaky,
      // so surface that instead of an empty carousel that would read as "no
      // recommendations available".
      if (requestedIds.length > 0 && recommendedProductList.length === 0) {
        throw failures[0].error;
      }

      return res.status(200).json(recommendedProductList);
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
