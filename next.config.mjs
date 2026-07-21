/** @type {import('next').NextConfig} */
const nextConfig = {
  // /call/[id] mints short-lived Deepgram API keys (rate-limited to 250/day)
  // and opens a WebSocket on mount. Strict Mode's dev-only double-invoke
  // (mount → cleanup → mount) doubles that real external-API cost on every
  // reload — not worth it for what Strict Mode currently catches here.
  reactStrictMode: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.avaturn.dev" },
      { protocol: "https", hostname: "*.avaturn.me" },
    ],
  },
};

export default nextConfig;