/**
 * Shared configuration for @imgly/background-removal, used both by the
 * dedicated worker and the main-thread fallback.
 *
 * Model assets are served same-origin from /imgly/<version>/ (a rewrite proxy
 * in next.config.mjs). Same-origin assets satisfy the COEP policy that enables
 * multi-threaded WASM, get immutable cache headers (the upstream CDN sends
 * none, so browsers would otherwise re-download ~44MB), and can be cached by
 * the service worker for offline/instant repeat loads.
 */

/** Must match the @imgly/background-removal version in package.json — its
 * runtime pins data assets to its own version on the upstream CDN. */
export const IMGLY_DATA_VERSION = "1.7.0"

export type ProgressFn = (key: string, current: number, total: number) => void

export function removalConfig(origin: string) {
  return {
    publicPath: `${origin}/imgly/${IMGLY_DATA_VERSION}/`,
    // quint8 halves the download vs the default fp16 model (44MB vs 88MB) and
    // int8 conv runs faster in WASM on phone CPUs, with near-identical masks.
    model: "isnet_quint8",
    device: "cpu",
    output: { format: "image/png", quality: 1 },
  } as const
}
