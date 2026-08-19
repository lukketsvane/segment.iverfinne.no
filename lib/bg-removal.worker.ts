/// <reference lib="webworker" />
/**
 * Runs the ML background removal off the main thread. imgly only proxies to a
 * worker itself for the WebGPU path; on CPU its inference would block the UI
 * for seconds per image, so we host the whole pipeline (decode, tensor prep,
 * inference, compositing, PNG decode of the result) in this worker instead.
 */
import { preload, removeBackground } from "@imgly/background-removal"
import { removalConfig } from "./bg-removal-config"

type Request = { id: number; kind: "preload" } | { id: number; kind: "remove"; blob: Blob }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  const config = {
    ...removalConfig(scope.location.origin),
    progress: (key: string, current: number, total: number) => {
      scope.postMessage({ id: request.id, kind: "progress", key, current, total })
    },
  }
  try {
    if (request.kind === "preload") {
      await preload(config)
      scope.postMessage({ id: request.id, kind: "done" })
      return
    }
    const cutout = await removeBackground(request.blob, config)
    // Decode here too, so the multi-megapixel PNG decode never hits the main
    // thread; the bitmap transfers back zero-copy.
    const bitmap = await createImageBitmap(cutout)
    scope.postMessage({ id: request.id, kind: "done", bitmap }, [bitmap])
  } catch (error) {
    scope.postMessage({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
