import dynamic from "next/dynamic";
import Head from "next/head";

// swagger-ui-react bundles a large JS file — load it client-side only
const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

// The CSS must be imported globally or here for the Swagger UI styling
import "swagger-ui-react/swagger-ui.css";

export default function DocsPage() {
  const specUrl = `${process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001"}/openapi.json`;

  return (
    <>
      <Head>
        <title>EarnYld - API Docs</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="shortcut icon" href="/favicon.svg" />
      </Head>
      <div className="min-h-screen bg-white dark:bg-gray-950">
        {/* Header */}
        <div className="border-b border-gray-200 dark:border-gray-800 px-6 py-4">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                EarnGen API
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Yield Hunter REST API — Uniswap v4 · 18 chains · mainnet + testnet
              </p>
            </div>
            <a
              href="/"
              className="text-sm text-indigo-600 hover:underline dark:text-indigo-400"
            >
              ← Dashboard
            </a>
          </div>
        </div>

        {/* Swagger UI */}
        <div className="max-w-6xl mx-auto px-4 py-6">
          <SwaggerUI
            url={specUrl}
            docExpansion="list"
            defaultModelsExpandDepth={1}
            tryItOutEnabled
          />
        </div>
      </div>
    </>
  );
}
