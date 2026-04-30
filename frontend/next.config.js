/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions: ["tsx", "ts", "jsx", "js"],
  // ox (viem/wagmi transitive dep) ships .ts source files that cause "type instantiation
  // excessively deep" errors in the TS compiler. Ignore them at build time.
  typescript: { ignoreBuildErrors: true },
};

module.exports = nextConfig;
