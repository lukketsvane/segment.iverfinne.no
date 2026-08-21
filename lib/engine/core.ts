/**
 * One lazily created runner per context, with a fallback path. Shared by the
 * worker and the main-thread fallback so both behave identically.
 */
import { beginGpuAttempt, finishGpuAttempt } from "./canary"
import { choosePlan } from "./plan"
import { createRunner, type ProgressFn, type Runner } from "./runtime"
import { decode, segment, type SegmentResult } from "./segment"

let pending: Promise<Runner> | null = null

export async function getRunner(onProgress?: ProgressFn): Promise<Runner> {
  if (pending) return pending
  pending = (async () => {
    const plan = await choosePlan()
    if (plan.backend === "webgpu") await beginGpuAttempt()
    try {
      return await createRunner(plan, onProgress)
    } catch (error) {
      // A GPU that advertises the limits but cannot compile the graph, or a
      // download that failed halfway: retry once on the combination that works
      // everywhere rather than failing the whole app.
      if (plan.backend === "wasm") throw error
      return createRunner(await choosePlan(true), onProgress)
    }
  })()
  pending.catch(() => {
    pending = null
  })
  return pending
}

export async function warm(onProgress?: ProgressFn): Promise<void> {
  await getRunner(onProgress)
}

export async function cutout(source: Blob, onProgress?: ProgressFn): Promise<SegmentResult> {
  const runner = await getRunner(onProgress)
  const bitmap = await decode(source)
  let result: SegmentResult
  try {
    result = await segment(bitmap, runner)
  } finally {
    bitmap.close?.()
  }
  // A full photo has now survived download, session and inference; whatever the
  // GPU was going to do to this device, it did not.
  if (runner.backend === "webgpu") await finishGpuAttempt()
  return result
}

export type { SegmentResult }
