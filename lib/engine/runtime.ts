/**
 * Owns the ONNX Runtime session: fetching weights (once, then from Cache
 * Storage forever), configuring the backend, and running a single square tensor
 * through the graph.
 */
import type { InferenceSession, Tensor } from "onnxruntime-web"
import type { ModelSpec } from "./models"
import type { Backend, Plan } from "./plan"

/**
 * Must match the onnxruntime-web version in package.json; scripts/copy-ort-assets.mjs
 * copies the matching runtime to public/ort/<version>/ and fails the build if
 * the two ever drift.
 */
export const ORT_VERSION = "1.27.0"

const MODEL_CACHE = "segment-models-v1"

export type ProgressFn = (key: string, current: number, total: number) => void

type OrtModule = typeof import("onnxruntime-web")

let ortPromise: Promise<OrtModule> | null = null
let ortBackend: Backend | null = null

async function loadOrt(plan: Plan): Promise<OrtModule> {
  if (ortPromise && ortBackend === plan.backend) return ortPromise
  ortBackend = plan.backend
  ortPromise = (async () => {
    // Two entry points, so a CPU-only device never downloads the 23MB WebGPU
    // runtime when the 12MB one is all it can use.
    const ort: OrtModule =
      plan.backend === "webgpu"
        ? ((await import("onnxruntime-web/webgpu")) as unknown as OrtModule)
        : ((await import("onnxruntime-web/wasm")) as unknown as OrtModule)
    ort.env.wasm.wasmPaths = `${self.location.origin}/ort/${ORT_VERSION}/`
    ort.env.wasm.numThreads = plan.threads
    // We are already off the main thread; ORT's own proxy worker would only add a hop.
    ort.env.wasm.proxy = false
    return ort
  })()
  return ortPromise
}

/**
 * Streams the weights, reporting bytes as they land. The upstream CDN is tried
 * first (a CORS fetch satisfies the page's COEP policy); the same-origin proxy
 * is the fallback for a rate limit or an outage.
 */
async function fetchWeights(spec: ModelSpec, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE).catch(() => null)
  const cached = await cache?.match(spec.url).catch(() => undefined)
  if (cached) return cached.arrayBuffer()

  let response: Response | null = null
  for (const url of [spec.url, spec.proxyUrl]) {
    response = await fetch(url, { mode: "cors", credentials: "omit" }).catch(() => null)
    if (response?.ok && response.body) break
    response = null
  }
  if (!response?.body) throw new Error(`Could not download ${spec.id}.`)

  const declared = Number(response.headers.get("content-length")) || spec.bytes
  const buffer = new Uint8Array(declared)
  const overflow: Uint8Array[] = []
  const reader = response.body.getReader()
  let offset = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // The declared length is authoritative in practice, but a proxy could
    // re-encode; keep any excess rather than truncating the model.
    if (offset + value.length <= declared) buffer.set(value, offset)
    else overflow.push(value)
    offset += value.length
    onProgress?.(`fetch:${spec.id}`, Math.min(offset, declared), declared)
  }

  let bytes: Uint8Array
  if (overflow.length === 0 && offset === declared) {
    bytes = buffer
  } else {
    bytes = new Uint8Array(offset)
    bytes.set(buffer.subarray(0, Math.min(offset, declared)), 0)
    let at = Math.min(offset, declared)
    for (const chunk of overflow) {
      bytes.set(chunk, at)
      at += chunk.length
    }
  }

  const body = bytes.slice().buffer
  // Store under the pinned upstream URL, which names exact bytes and so can be
  // kept indefinitely. Quota failures are not fatal — the model just re-downloads.
  cache
    ?.put(spec.url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }))
    .catch(() => {})
  return body
}

export type Runner = {
  spec: ModelSpec
  backend: Backend
  /** Whether this device can afford the zoomed second inference pass. */
  refinePass: boolean
  /** Runs one square RGB tensor and returns the raw single-channel output. */
  run(input: Float32Array, size: number): Promise<Float32Array>
}

export async function createRunner(plan: Plan, onProgress?: ProgressFn): Promise<Runner> {
  const ort = await loadOrt(plan)
  const weights = await fetchWeights(plan.model, onProgress)
  const session: InferenceSession = await ort.InferenceSession.create(weights, {
    executionProviders: [plan.backend],
    graphOptimizationLevel: "all",
    executionMode: "sequential",
  })
  const spec = plan.model

  return {
    spec,
    backend: plan.backend,
    refinePass: plan.refinePass,
    async run(input: Float32Array, size: number): Promise<Float32Array> {
      const tensor: Tensor = new ort.Tensor("float32", input, [1, 3, size, size])
      const outputs = await session.run({ [spec.inputName]: tensor })
      const output = outputs[spec.outputName] ?? Object.values(outputs)[0]
      const data = output.data as Float32Array
      // Free the GPU/WASM-side copy immediately; a 1024² fp32 map is 4MB a pass.
      const copy = new Float32Array(data)
      output.dispose?.()
      tensor.dispose?.()
      return copy
    },
  }
}
