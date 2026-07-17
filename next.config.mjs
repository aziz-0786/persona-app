/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.avaturn.dev" },
      { protocol: "https", hostname: "*.avaturn.me" },
    ],
  },
};

export default nextConfig;