import { removalConfig, type ProgressFn } from "./bg-removal-config"

type Job = {
  resolve: (bitmap: ImageBitmap | undefined) => void
  reject: (error: Error) => void
  onProgress?: ProgressFn
}

type WorkerReply =
  | { id: number; kind: "progress"; key: string; current: number; total: number }
  | { id: number; kind: "done"; bitmap?: ImageBitmap }
  | { id: number; kind: "error"; message: string }

// undefined = not created yet, null = could not boot (fall back to main thread)
let worker: Worker | null | undefined
let workerProven = false
let nextId = 1
const jobs = new Map<number, Job>()

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  let created: Worker
  try {
    created = new Worker(new URL("./bg-removal.worker.ts", import.meta.url), { type: "module" })
  } catch {
    worker = null
    return worker
  }
  created.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data
    const job = jobs.get(reply.id)
    if (!job) return
    if (reply.kind === "progress") {
      job.onProgress?.(reply.key, reply.current, reply.total)
      return
    }
    workerProven = true
    jobs.delete(reply.id)
    if (reply.kind === "done") job.resolve(reply.bitmap)
    else job.reject(new Error(reply.message))
  }
  created.onerror = () => {
    // Script load failure or a crash. If it never completed a job, disable the
    // worker path for good; otherwise let the next job spawn a fresh worker.
    created.terminate()
    worker = workerProven ? undefined : null
    const error = new Error("Background removal worker failed.")
    for (const job of jobs.values()) job.reject(error)
    jobs.clear()
  }
  worker = created
  return worker
}

async function mainThreadFallback(request: { kind: "preload" } | { kind: "remove"; blob: Blob }, onProgress?: ProgressFn) {
  const { preload, removeBackground } = await import("@imgly/background-removal")
  const config = { ...removalConfig(location.origin), progress: onProgress }
  if (request.kind === "preload") {
    await preload(config)
    return undefined
  }
  const cutout = await removeBackground(request.blob, config)
  return createImageBitmap(cutout)
}

async function run(
  request: { kind: "preload" } | { kind: "remove"; blob: Blob },
  onProgress?: ProgressFn,
): Promise<ImageBitmap | undefined> {
  const target = getWorker()
  if (target) {
    const id = nextId++
    try {
      return await new Promise<ImageBitmap | undefined>((resolve, reject) => {
        jobs.set(id, { resolve, reject, onProgress })
        target.postMessage({ id, ...request })
      })
    } catch (error) {
      // Only fall back when the worker could not boot at all; a processing
      // error would just fail the same way (and cost) on the main thread.
      if (worker !== null) throw error
    }
  }
  return mainThreadFallback(request, onProgress)
}

/** Warms the model: fetches assets and compiles the inference session. */
export async function preloadModel(onProgress?: ProgressFn): Promise<void> {
  await run({ kind: "preload" }, onProgress)
}

/** Removes the background and returns the cutout as a decoded ImageBitmap. */
export async function removeSubject(blob: Blob, onProgress?: ProgressFn): Promise<ImageBitmap> {
  const bitmap = await run({ kind: "remove", blob }, onProgress)
  if (!bitmap) throw new Error("Background removal returned no image.")
  return bitmap
}
