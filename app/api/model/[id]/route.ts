import { MODELS, type ModelId } from "@/lib/engine/models"

/**
 * Same-origin fallback for the model weights.
 *
 * The engine fetches straight from the upstream CDN first — a CORS fetch
 * satisfies the page's COEP policy and costs us no bandwidth. This route exists
 * for the cases that leaves behind: a rate limit, an outage, or a network that
 * blocks the host. It follows the redirect the CDN issues and streams the body
 * through, which the client cannot do itself under COEP.
 */

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const spec = MODELS[id as ModelId]
  if (!spec) return new Response("Unknown model.", { status: 404 })

  const upstream = await fetch(spec.url, { redirect: "follow" }).catch(() => null)
  if (!upstream?.ok || !upstream.body) return new Response("Weights are unavailable.", { status: 502 })

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(spec.bytes),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  })
}
