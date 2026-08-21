/**
 * Picks which model to run and on what backend, from what the device can
 * actually do. Runs inside the worker, where navigator.gpu and the network
 * hints are both available.
 */
import { MODELS, type ModelId, type ModelSpec } from "./models"

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
type GpuLike = {
  requestAdapter(options?: { powerPreference?: string }): Promise<{ limits: { maxStorageBufferBindingSize: number } } | null>
}

/**
 * BiRefNet-lite allocates a few hundred MB of intermediate tensors at 1024².
 * An adapter that cannot bind buffers this large fails at session creation, so
 * it is filtered out before we commit to the download.
 */
const MIN_STORAGE_BUFFER = 128 * 1024 * 1024

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
    return !!adapter && adapter.limits.maxStorageBufferBindingSize >= MIN_STORAGE_BUFFER
  } catch {
    return false
  }
}

export async function choosePlan(force?: ModelId): Promise<Plan> {
  const isolated = typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false
  const cores = navigator.hardwareConcurrency || 2
  // Past four threads the graph is memory bound rather than compute bound, and
  // the extra workers just compete with the browser's compositor on a phone.
  const threads = isolated ? Math.max(1, Math.min(4, cores - 1)) : 1

  const gpu = await webgpuAvailable()
  // The big model earns its download only where a GPU can run it: on WASM it is
  // roughly ten times slower than IS-Net, which is the difference between a few
  // seconds and most of a minute.
  const useBig = force ? force === "birefnet-lite-fp16" : gpu && !frugalNetwork()
  const model = MODELS[useBig ? "birefnet-lite-fp16" : "isnet-quint8"]

  // IS-Net's weights are int8 QDQ, which the WebGPU backend only partly covers —
  // the fallbacks make it slower than plain threaded WASM. Only the fp16 model
  // goes to the GPU.
  const backend: Backend = model.id === "birefnet-lite-fp16" && gpu ? "webgpu" : "wasm"

  return { backend, model, threads, refinePass: backend === "webgpu" || threads > 1 }
}
