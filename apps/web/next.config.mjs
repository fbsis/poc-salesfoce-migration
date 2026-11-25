import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript sources directly (no build step).
  transpilePackages: ['@poc/core', '@poc/salesforce'],
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  eslint: { ignoreDuringBuilds: true },
  logging: { fetches: { fullUrl: true } },
};

export default nextConfig;
