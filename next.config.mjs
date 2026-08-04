/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    // Anchor Turbopack to this Next.js app rather than a parent directory
    // selected from an unrelated lockfile. `process.cwd()` is the configured
    // app root in both local development and Vercel builds.
    root: process.cwd(),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
