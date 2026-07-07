/** @type {import('next').NextConfig} */
const nextConfig = {
  // The chat route spawns the `claude` CLI, so these routes must run on the
  // Node.js runtime (not edge). Marked per-route via `export const runtime`.
  reactStrictMode: true,
  // Allow large-ish raw-file uploads through the route handler.
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default nextConfig;
