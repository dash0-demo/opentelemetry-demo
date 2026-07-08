// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import Document, { DocumentContext, Html, Head, Main, NextScript } from 'next/document';
import { ServerStyleSheet } from 'styled-components';

// Server-render-time environment variables inlined into `window.ENV` for the
// client-side Dash0 Web SDK (see utils/telemetry/DashZeroWebSdk.ts). Keeping
// them here rather than as `NEXT_PUBLIC_*` build-time bakes lets the same
// image work across tenants — only the deployment's env vars change.
const {
  ENV_PLATFORM,
  WEB_OTEL_SERVICE_NAME,
  PUBLIC_DASH0_WEB_SDK_ENDPOINT,
  PUBLIC_DASH0_WEB_SDK_SERVICE_VERSION,
  PUBLIC_DASH0_WEB_SDK_SERVICE_NAMESPACE,
  PUBLIC_DASH0_WEB_SDK_VCS_REPO_URL,
  PUBLIC_DASH0_WEB_SDK_VCS_HEAD_SHA,
} = process.env;

export default class MyDocument extends Document<{ envString: string }> {
  static async getInitialProps(ctx: DocumentContext) {
    const sheet = new ServerStyleSheet();
    const originalRenderPage = ctx.renderPage;

    try {
      ctx.renderPage = () =>
        originalRenderPage({
          enhanceApp: App => props => sheet.collectStyles(<App {...props} />),
        });

      const initialProps = await Document.getInitialProps(ctx);

      // JSON.stringify handles all string escaping (quotes, backslashes,
      // newlines, control chars) safely — and its output is valid JS too,
      // so we can drop it verbatim into a <script> body.
      const envString = `window.ENV = ${JSON.stringify({
        NEXT_PUBLIC_PLATFORM: ENV_PLATFORM ?? '',
        NEXT_PUBLIC_OTEL_SERVICE_NAME: WEB_OTEL_SERVICE_NAME ?? '',
        NEXT_PUBLIC_DASH0_WEB_SDK_ENDPOINT: PUBLIC_DASH0_WEB_SDK_ENDPOINT ?? '',
        NEXT_PUBLIC_DASH0_WEB_SDK_SERVICE_VERSION: PUBLIC_DASH0_WEB_SDK_SERVICE_VERSION ?? '',
        NEXT_PUBLIC_DASH0_WEB_SDK_SERVICE_NAMESPACE: PUBLIC_DASH0_WEB_SDK_SERVICE_NAMESPACE ?? '',
        NEXT_PUBLIC_DASH0_WEB_SDK_VCS_REPO_URL: PUBLIC_DASH0_WEB_SDK_VCS_REPO_URL ?? '',
        NEXT_PUBLIC_DASH0_WEB_SDK_VCS_HEAD_SHA: PUBLIC_DASH0_WEB_SDK_VCS_HEAD_SHA ?? '',
      })};`;
      return {
        ...initialProps,
        styles: [initialProps.styles, sheet.getStyleElement()],
        envString,
      };
    } finally {
      sheet.seal();
    }
  }

  render() {
    return (
      <Html>
        <Head>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link
            href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,300;1,400;1,500;1,600;1,700;1,800&display=swap"
            rel="stylesheet"
          />
        </Head>
        <body>
          <Main />
          <script dangerouslySetInnerHTML={{ __html: this.props.envString }}></script>
          <NextScript />
        </body>
      </Html>
    );
  }
}
