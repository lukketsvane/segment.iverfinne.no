/**
 * The segmentation models the engine can run, and everything needed to feed and
 * read them. Both are fully convolutional saliency networks that take a square
 * RGB tensor and return a single-channel matte.
 *
 * Weights are fetched from the Hugging Face CDN pinned to a commit, so a URL
 * always names the exact same bytes and can be cached forever.
 */

export type ModelId = "isnet-quint8" | "birefnet-lite-fp16"

export type ModelSpec = {
  id: ModelId
  /** Pinned upstream URL. Cross-origin, but fetched in CORS mode, which satisfies COEP. */
  url: string
  /** Same-origin proxy, used only if the upstream fetch fails (rate limit, outage). */
  proxyUrl: string
  /** Exact byte length, so download progress is known before the first chunk. */
  bytes: number
  /** Square edge the network was trained at. */
  inputSize: number
  inputName: string
  outputName: string
  /** Raw 0-255 pixels are divided by this, then normalised per channel. */
  scale: number
  mean: readonly [number, number, number]
  std: readonly [number, number, number]
  /** Output is logits and needs a sigmoid (BiRefNet) rather than being a probability already (IS-Net). */
  logits: boolean
  /**
   * Levels remap applied to the finished matte, as [black point, white point].
   * IS-Net leaves a low-confidence haze over textured backgrounds that reads as
   * grey fog once composited; BiRefNet's matte is already decisive, so it gets a
   * far gentler curve that preserves genuine soft edges.
   */
  levels: readonly [number, number]
}

export const MODELS: Record<ModelId, ModelSpec> = {
  /** IS-Net (DIS), weight-only int8. Same network the previous engine ran, at the same size. */
  "isnet-quint8": {
    id: "isnet-quint8",
    url: "https://huggingface.co/xrds/isnet-general-onnx-int8/resolve/71eff2372ec9c8edbc6ca637ded591423d23b65a/onnx/model_quantized.onnx",
    proxyUrl: "/api/model/isnet-quint8",
    bytes: 44_229_662,
    inputSize: 1024,
    inputName: "input",
    outputName: "output",
    scale: 1,
    mean: [128, 128, 128],
    std: [256, 256, 256],
    logits: false,
    levels: [0.08, 0.92],
  },
  /** BiRefNet-lite, fp16 weights with fp32 IO. Markedly better on low contrast, backlit and cluttered scenes. */
  "birefnet-lite-fp16": {
    id: "birefnet-lite-fp16",
    url: "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx",
    proxyUrl: "/api/model/birefnet-lite-fp16",
    bytes: 114_538_221,
    inputSize: 1024,
    inputName: "input_image",
    outputName: "output_image",
    scale: 255,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    logits: true,
    levels: [0.02, 0.98],
  },
}
