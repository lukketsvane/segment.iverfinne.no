/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
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
        // The ONNX Runtime binaries, copied out of node_modules into a
        // version-stamped directory by scripts/copy-ort-assets.mjs.
        source: '/ort/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // Fallback weight proxy: the URL pins a commit, so the bytes never change.
        source: '/api/model/:path*',
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
