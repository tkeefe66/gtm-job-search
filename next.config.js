/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // Restrict embedding without disrupting Next scripts or résumé styles.
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
      ],
    }];
  },
  serverExternalPackages: ["unpdf", "mammoth"],
  experimental: {
    // Leave room for multipart overhead around the 1 MB résumé upload limit.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

module.exports = nextConfig;
