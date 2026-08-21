/**
 * One lazily created runner per context, with a fallback path. Shared by the
 * worker and the main-thread fallback so both behave identically.
 */
import { choosePlan } from "./plan"
import { createRunner, type ProgressFn, type Runner } from "./runtime"
import { decode, segment, type SegmentResult } from "./segment"

let pending: Promise<Runner> | null = null

export async function getRunner(onProgress?: ProgressFn): Promise<Runner> {
  if (pending) return pending
  pending = (async () => {
    const plan = await choosePlan()
    try {
      return await createRunner(plan, onProgress)
    } catch (error) {
      // A GPU that advertises the limits but cannot compile the graph, or a
      // download that failed halfway: retry once on the combination that works
      // everywhere rather than failing the whole app.
      if (plan.backend === "wasm" && plan.model.id === "isnet-quint8") throw error
      return createRunner(await choosePlan("isnet-quint8"), onProgress)
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
  try {
    return await segment(bitmap, runner)
  } finally {
    bitmap.close?.()
  }
}

export type { SegmentResult }
