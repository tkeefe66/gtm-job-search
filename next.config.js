/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Leave room for multipart overhead around the 1 MB résumé upload limit.
    serverActions: { bodySizeLimit: "2mb" },
    serverComponentsExternalPackages: ["unpdf", "mammoth"],
  },
};

module.exports = nextConfig;
