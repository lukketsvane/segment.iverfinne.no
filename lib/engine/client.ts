/**
 * Main-thread handle on the engine. Talks to the worker, and runs the same
 * pipeline inline if the worker cannot be created at all.
 */
import type { ModelId } from "./models"
import type { Backend } from "./plan"
import type { ProgressFn } from "./runtime"

export type { ProgressFn }

export type Matte = {
  data: Uint8ClampedArray
  width: number
  height: number
  model: ModelId
  backend: Backend
  zoomed: boolean
}

type Request = { kind: "preload" } | { kind: "segment"; blob: Blob }

type Reply =
  | { id: number; kind: "progress"; key: string; current: number; total: number }
  | { id: number; kind: "ready" }
  | ({ id: number; kind: "matte" } & Matte)
  | { id: number; kind: "error"; message: string }

type Job = {
  resolve: (matte: Matte | undefined) => void
  reject: (error: Error) => void
  onProgress?: ProgressFn
}

// undefined = not created yet, null = cannot be created (run inline instead)
let worker: Worker | null | undefined
let workerProven = false
let nextId = 1
const jobs = new Map<number, Job>()

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  let created: Worker
  try {
    created = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
  } catch {
    worker = null
    return worker
  }
  created.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data
    const job = jobs.get(reply.id)
    if (!job) return
    if (reply.kind === "progress") {
      job.onProgress?.(reply.key, reply.current, reply.total)
      return
    }
    workerProven = true
    jobs.delete(reply.id)
    if (reply.kind === "error") job.reject(new Error(reply.message))
    else if (reply.kind === "ready") job.resolve(undefined)
    else job.resolve(reply)
  }
  created.onerror = () => {
    // Script load failure or a crash. If it never completed a job, give up on
    // the worker for good; otherwise let the next job spawn a fresh one.
    created.terminate()
    worker = workerProven ? undefined : null
    const error = new Error("The segmentation worker failed.")
    for (const job of jobs.values()) job.reject(error)
    jobs.clear()
  }
  worker = created
  return worker
}

async function inline(request: Request, onProgress?: ProgressFn): Promise<Matte | undefined> {
  const { cutout, warm } = await import("./core")
  if (request.kind === "preload") {
    await warm(onProgress)
    return undefined
  }
  return cutout(request.blob, onProgress)
}

async function run(request: Request, onProgress?: ProgressFn): Promise<Matte | undefined> {
  const target = getWorker()
  if (target) {
    const id = nextId++
    try {
      return await new Promise<Matte | undefined>((resolve, reject) => {
        jobs.set(id, { resolve, reject, onProgress })
        target.postMessage({ id, ...request })
      })
    } catch (error) {
      // Only retry inline when the worker itself is unusable; a processing
      // failure would fail the same way on the main thread, at the cost of a freeze.
      if (worker !== null) throw error
    }
  }
  return inline(request, onProgress)
}

/** Downloads the weights and compiles the inference session ahead of the first photo. */
export async function preloadEngine(onProgress?: ProgressFn): Promise<void> {
  await run({ kind: "preload" }, onProgress)
}

/** Segments one image and returns the finished straight-alpha cutout. */
export async function cutoutImage(blob: Blob, onProgress?: ProgressFn): Promise<Matte> {
  const matte = await run({ kind: "segment", blob }, onProgress)
  if (!matte) throw new Error("Segmentation returned no image.")
  return matte
}
