/**
 * Picks which model to run and on what backend, from what the device can
 * actually do. Runs inside the worker, where navigator.gpu and the network
 * hints are both available.
 */
import { gpuAttemptUnfinished } from "./canary"
import { MODELS, type ModelSpec } from "./models"

export type Backend = "webgpu" | "wasm"

export type Plan = {
  backend: Backend
  model: ModelSpec
  /** Threads for the WASM backend; 1 without cross-origin isolation. */
  threads: number
  /**
   * Whether to spend a second inference pass zooming into the subject. It is a
   * large quality win everywhere, but on a single-threaded CPU it doubles a wait
   * that is already long, so it is skipped there.
   */
  refinePass: boolean
}

/** Minimal shape of the bits of WebGPU we touch; the DOM lib does not declare them. */
type AdapterLike = {
  limits: { maxStorageBufferBindingSize: number }
  info?: { architecture?: string; description?: string; vendor?: string }
  isFallbackAdapter?: boolean
}

type GpuLike = {
  requestAdapter(options?: { powerPreference?: string }): Promise<AdapterLike | null>
}

/**
 * BiRefNet-lite allocates a few hundred MB of intermediate tensors at 1024².
 * An adapter that cannot bind buffers this large fails at session creation, so
 * it is filtered out before we commit to the download.
 */
const MIN_STORAGE_BUFFER = 128 * 1024 * 1024

/**
 * Software rasterisers answer requestAdapter like real hardware, then run the
 * graph on the CPU anyway — slower than threaded WASM, and heavy enough at
 * 1024² to take the tab down with it.
 */
const SOFTWARE = /swiftshader|lavapipe|llvmpipe|softwarerasterizer|microsoft basic render/i

function isSoftware(adapter: AdapterLike): boolean {
  if (adapter.isFallbackAdapter) return true
  const info = adapter.info
  if (!info) return false
  return SOFTWARE.test(`${info.vendor ?? ""} ${info.architecture ?? ""} ${info.description ?? ""}`)
}

/** True when the user has asked to conserve data, or is on a slow link. */
function frugalNetwork(): boolean {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection
  if (!connection) return false
  if (connection.saveData) return true
  const type = connection.effectiveType
  return type === "slow-2g" || type === "2g" || type === "3g"
}

async function webgpuAvailable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) return false
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" })
    if (!adapter || isSoftware(adapter)) return false
    return adapter.limits.maxStorageBufferBindingSize >= MIN_STORAGE_BUFFER
  } catch {
    return false
  }
}

export async function choosePlan(preferSmall = false): Promise<Plan> {
  const isolated = typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false
  const cores = navigator.hardwareConcurrency || 2
  // Past four threads the graph is memory bound rather than compute bound, and
  // the extra workers just compete with the browser's compositor on a phone.
  const threads = isolated ? Math.max(1, Math.min(4, cores - 1)) : 1

  // BiRefNet only ever runs on a real GPU. It is an order of magnitude slower
  // than IS-Net on WASM and heavy enough at 1024² to take the tab down with it,
  // so the two choices move together: big model on the GPU, small one on the CPU.
  const gpu = !preferSmall && !(await gpuAttemptUnfinished()) && (await webgpuAvailable())
  const useBig = gpu && !frugalNetwork()
  const model = MODELS[useBig ? "birefnet-lite-fp16" : "isnet-quint8"]
  const backend: Backend = useBig ? "webgpu" : "wasm"

  return { backend, model, threads, refinePass: useBig || threads > 1 }
}
