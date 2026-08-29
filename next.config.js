/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  // Claude looks for OAuth discovery documents under /.well-known/. Next's App Router
  // will not route a directory whose name starts with a dot, so map them onto real routes.
  async rewrites() {
    return [
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-protected-resource/:path*', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/authorization-server' },
      { source: '/.well-known/oauth-authorization-server/:path*', destination: '/api/oauth/authorization-server' },
    ];
  },
};
