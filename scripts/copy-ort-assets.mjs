/**
 * Copies onnxruntime-web's WASM runtime out of node_modules into
 * public/ort/<version>/ so the browser loads it same-origin.
 *
 * Same-origin matters for three reasons: the COEP policy in next.config.mjs
 * would reject a CDN copy without CORP headers, cross-origin isolation is what
 * unlocks the SharedArrayBuffer that ORT's threaded build needs, and a static
 * file under a versioned path can carry immutable cache headers (a CDN proxy
 * cannot).
 *
 * Runs on postinstall (so `next dev` works straight after a clone) and again on
 * prebuild (so a cached node_modules on CI still produces the assets).
 */
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "node_modules", "onnxruntime-web", "dist")

if (!existsSync(dist)) {
  // Dependencies are not installed yet (e.g. `npm install` running the
  // postinstall of a partially built tree). prebuild will catch it.
  console.warn("[ort] onnxruntime-web not installed yet — skipping asset copy.")
  process.exit(0)
}

const { version } = JSON.parse(
  await readFile(join(root, "node_modules", "onnxruntime-web", "package.json"), "utf8"),
)
const target = join(root, "public", "ort", version)

// The worker builds this URL from a constant, so a version bump that only lands
// in package.json would 404 at runtime. Fail here instead.
const runtime = await readFile(join(root, "lib", "engine", "runtime.ts"), "utf8")
const declared = /ORT_VERSION = "([^"]+)"/.exec(runtime)?.[1]
if (declared !== version) {
  throw new Error(
    `[ort] version mismatch: onnxruntime-web is ${version}, ORT_VERSION in lib/engine/runtime.ts is ${declared}.`,
  )
}

// Two of the four threaded builds: the plain one backs the CPU entry point, the
// asyncify one backs WebGPU. (The jsep and jspi variants belong to entry points
// this app does not import, and are ~40MB of dead weight in the deployment.)
const wanted = /^ort-wasm-simd-threaded(\.asyncify)?\.(wasm|mjs)$/

const files = (await readdir(dist)).filter((name) => wanted.test(name))
if (files.length === 0) throw new Error(`[ort] no runtime assets matched in ${dist}`)

await rm(join(root, "public", "ort"), { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const name of files) await copyFile(join(dist, name), join(target, name))

console.log(`[ort] copied ${files.length} files to public/ort/${version}/`)
