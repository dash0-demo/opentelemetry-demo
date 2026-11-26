// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api';
import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import AdGateway from '../../gateways/rpc/Ad.gateway';
import { Ad, Empty } from '../../protos/demo';

type TResponse = Ad[] | Empty;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const { contextKeys = [] } = query;
      try {
        const { ads: adList } = await AdGateway.listAds(
          Array.isArray(contextKeys) ? contextKeys : contextKeys.split(',')
        );

        return res.status(200).json(adList);
      } catch (error) {
        // Ads are non-critical: when the ad service fails (e.g. RESOURCE_EXHAUSTED, UNAVAILABLE),
        // record the error on the active span and degrade to an empty list instead of returning a 500.
        const span = trace.getActiveSpan();
        if (span) {
          span.recordException(error as Error);
        }
        return res.status(200).json([]);
      }
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
