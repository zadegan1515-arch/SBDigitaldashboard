/** @type {import('next').NextConfig} */

// The brand-facing sponsor page also answers on its own hostname
// (SPONSOR_HOST, e.g. shows.sboyagency.com — add it as a domain on the
// Vercel project and a CNAME in DNS). On that host, "/" is the sponsor
// page; middleware sends everything else there too, so a brand never
// sees the Command Center.
const SPONSOR_HOST = process.env.SPONSOR_HOST || 'shows.sboyagency.com'

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/', has: [{ type: 'host', value: SPONSOR_HOST }], destination: '/sponsor.html' },
    ]
  },
}

module.exports = nextConfig
