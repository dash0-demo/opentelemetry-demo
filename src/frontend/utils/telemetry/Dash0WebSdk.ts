// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Browser-side Dash0 Web SDK initializer.
//
// Replaces the demo's upstream OpenTelemetry-JS Web SDK (`FrontendTracer` +
// `SessionIdProcessor`) with the Dash0 SDK. All configuration flows through
// `window.ENV` (see pages/_document.tsx) so per-tenant differences (endpoint,
// namespace, VCS metadata) stay out of the image.
//
// `window.seed` is optionally set by the load-generator's Playwright users
// (see the deployment's loadgen/locustfile.py `seed_person`) before any page
// script runs. When present we identify the user and tag signals with the
// seeded geo attributes, so Web Monitoring sessions differentiate by user
// and origin rather than all collapsing to the pod IP's geolocation.

import { init, identify, addSignalAttribute } from '@dash0/sdk-web';
import SessionGateway from '../../gateways/Session.gateway';

const Dash0WebSdk = () => {
  if (typeof window === 'undefined') return;

  const env = window.ENV || {};
  const endpointUrl = env.NEXT_PUBLIC_DASH0_WEB_SDK_ENDPOINT || window.location.origin + '/_dash0';

  init({
    serviceName: env.NEXT_PUBLIC_OTEL_SERVICE_NAME || 'frontend-web',
    serviceVersion: env.NEXT_PUBLIC_DASH0_WEB_SDK_SERVICE_VERSION || '',
    endpoint: { url: endpointUrl, authToken: '' },
    // Explicit propagator entry — without one, same-origin `traceparent`
    // injection isn't automatic and browser traces don't correlate with
    // backend spans.
    propagators: [{ type: 'traceparent', match: [/.*/] }],
    // Silence the demo's own hydration mismatch (React #418) which fires on
    // every route change and would otherwise dominate the error count.
    ignoreErrorMessages: [/Minified React error #418/],
  });

  const svcNs = env.NEXT_PUBLIC_DASH0_WEB_SDK_SERVICE_NAMESPACE;
  if (svcNs) addSignalAttribute('service.namespace', svcNs);

  const vcsUrl = env.NEXT_PUBLIC_DASH0_WEB_SDK_VCS_REPO_URL;
  if (vcsUrl) addSignalAttribute('vcs.repository.url.full', vcsUrl);
  const vcsSha = env.NEXT_PUBLIC_DASH0_WEB_SDK_VCS_HEAD_SHA;
  if (vcsSha) addSignalAttribute('vcs.ref.head.revision', vcsSha);
  if (vcsUrl || vcsSha) addSignalAttribute('vcs.provider.name', 'github');

  // Persist the same session.id / enduser.id the app already uses locally.
  try {
    const { userId } = SessionGateway.getSession();
    if (userId) {
      addSignalAttribute('session.id', userId);
      addSignalAttribute('enduser.id', userId);
    }
  } catch {
    // Session storage unavailable — SDK still tracks its own session id.
  }

  // Optional seeded identity from Playwright's page.add_init_script.
  const seed = (window as unknown as { seed?: { email?: string; location?: { countryCode?: string; continentCode?: string; locality?: string } } }).seed;
  if (seed) {
    if (seed.location) {
      if (seed.location.countryCode) addSignalAttribute('geo.country.iso_code', seed.location.countryCode);
      if (seed.location.continentCode) addSignalAttribute('geo.continent.code', seed.location.continentCode);
      if (seed.location.locality) addSignalAttribute('geo.locality.name', seed.location.locality);
    }
    if (seed.email) identify(seed.email, { email: seed.email });
  }
};

export default Dash0WebSdk;
