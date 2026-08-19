/** Must match the @imgly/background-removal version (its runtime pins data
 * assets to its own version on the upstream CDN). */
const IMGLY_DATA_VERSION = '1.7.0'

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    // Serve the model + wasm assets same-origin: satisfies COEP (which unlocks
    // multi-threaded WASM), removes a third-party dependency from the critical
    // path, and lets us attach immutable cache headers the CDN doesn't send.
    return [
      {
        source: `/imgly/${IMGLY_DATA_VERSION}/:path*`,
        destination: `https://staticimgly.com/@imgly/background-removal-data/${IMGLY_DATA_VERSION}/dist/:path*`,
      },
    ]
  },
  async headers() {
    return [
      {
        // Cross-origin isolation enables SharedArrayBuffer, which lets
        // onnxruntime-web run the segmentation model on multiple threads
        // (~2-4x faster inference on iPhone CPUs).
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        // Versioned, content-stable model assets: cache forever.
        source: '/imgly/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ]
  },
}

export default nextConfig
