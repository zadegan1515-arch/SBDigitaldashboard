/** @type {import('next').NextConfig} */

// The brand-facing sponsor page also answers on its own hostname
// (SPONSOR_HOST, e.g. partnerships.sboyagency.com — add it as a domain on
// the Vercel project and a CNAME in DNS). On that host, "/" is the sponsor
// page; middleware sends everything else there too, so a brand never
// sees the Command Center. On every host, /partnerships is the page's
// friendly path (the old /sponsor.html URL keeps working).
const SPONSOR_HOST = process.env.SPONSOR_HOST || 'partnerships.sboyagency.com'

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/', has: [{ type: 'host', value: SPONSOR_HOST }], destination: '/sponsor.html' },
      { source: '/partnerships', destination: '/sponsor.html' },
    ]
  },
}

module.exports = nextConfig
