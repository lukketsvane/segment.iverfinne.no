/**
 * A crash canary for the GPU path.
 *
 * A session that throws can be caught and retried on the safe model. A device
 * whose GPU driver takes the whole tab down cannot — there is no catch block on
 * the other side of that. So a mark is written before the first GPU attempt and
 * cleared only once a photo has come out the other end intact; finding the mark
 * still set on the next visit means the last attempt never finished, and that
 * device sticks to the CPU model from then on.
 */
const FLAGS = "segment-flags-v1"
const GPU_ATTEMPT = "https://segment.invalid/gpu-attempt"

async function flags(): Promise<Cache | null> {
  try {
    return await caches.open(FLAGS)
  } catch {
    return null
  }
}

export async function gpuAttemptUnfinished(): Promise<boolean> {
  const cache = await flags()
  if (!cache) return false
  try {
    return !!(await cache.match(GPU_ATTEMPT))
  } catch {
    return false
  }
}

export async function beginGpuAttempt(): Promise<void> {
  const cache = await flags()
  await cache?.put(GPU_ATTEMPT, new Response("1")).catch(() => {})
}

export async function finishGpuAttempt(): Promise<void> {
  const cache = await flags()
  await cache?.delete(GPU_ATTEMPT).catch(() => {})
}
