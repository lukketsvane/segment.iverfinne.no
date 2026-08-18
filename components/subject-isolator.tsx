"use client"

import type React from "react"
import { useCallback, useRef, useState } from "react"
import { Download, ImageIcon, Loader2, RotateCcw, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { isolateSubject, type IsolateResult } from "@/lib/isolate"

type Status = "idle" | "processing" | "done" | "error"

const PADDING_OPTIONS = [
  { label: "None", value: 0 },
  { label: "Small", value: 6 },
  { label: "Medium", value: 12 },
  { label: "Large", value: 20 },
]

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SubjectIsolator() {
  const [status, setStatus] = useState<Status>("idle")
  const [padding, setPadding] = useState(12)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>("image")
  const [result, setResult] = useState<IsolateResult | null>(null)
  const [progress, setProgress] = useState<{ stage: string; ratio: number }>({ stage: "", ratio: 0 })
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  // Keep the source blob so padding can be re-applied without re-uploading.
  const sourceRef = useRef<Blob | null>(null)

  const run = useCallback(async (file: Blob, pad: number) => {
    setStatus("processing")
    setError(null)
    setResult(null)
    setProgress({ stage: "Preparing", ratio: 0 })
    try {
      const res = await isolateSubject(file, pad, (stage, ratio) => setProgress({ stage, ratio }))
      setResult(res)
      setStatus("done")
    } catch (err) {
      console.log("[v0] isolate error:", err)
      setError(err instanceof Error ? err.message : "Something went wrong while processing the image.")
      setStatus("error")
    }
  }, [])

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      if (!file.type.startsWith("image/")) {
        setError("Please choose an image file.")
        setStatus("error")
        return
      }
      sourceRef.current = file
      setFileName(file.name.replace(/\.[^.]+$/, ""))
      setOriginalUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(file)
      })
      run(file, padding)
    },
    [padding, run],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      handleFile(e.dataTransfer.files?.[0])
    },
    [handleFile],
  )

  const changePadding = useCallback(
    (value: number) => {
      setPadding(value)
      if (sourceRef.current && status !== "processing") {
        run(sourceRef.current, value)
      }
    },
    [run, status],
  )

  const reset = useCallback(() => {
    if (originalUrl) URL.revokeObjectURL(originalUrl)
    if (result) URL.revokeObjectURL(result.url)
    sourceRef.current = null
    setOriginalUrl(null)
    setResult(null)
    setStatus("idle")
    setError(null)
    setFileName("image")
  }, [originalUrl, result])

  const download = useCallback(() => {
    if (!result) return
    const a = document.createElement("a")
    a.href = result.url
    a.download = `${fileName}-isolated.png`
    a.click()
  }, [result, fileName])

  return (
    <div className="w-full">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {status === "idle" ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex w-full flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-colors sm:py-24 ${
            dragging
              ? "border-primary bg-primary/5"
              : "border-border bg-card hover:border-primary/60 hover:bg-accent/40"
          }`}
        >
          <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Upload className="size-6" />
          </span>
          <span className="space-y-1">
            <span className="block text-lg font-medium text-foreground text-balance">
              Drop an image or tap to upload
            </span>
            <span className="block text-sm text-muted-foreground text-pretty">
              We isolate the subject on solid white and trim the empty space.
            </span>
          </span>
        </button>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Original */}
            <figure className="overflow-hidden rounded-2xl border border-border bg-card">
              <figcaption className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ImageIcon className="size-3.5" />
                Original
              </figcaption>
              <div className="flex aspect-square items-center justify-center bg-[repeating-conic-gradient(var(--muted)_0deg_90deg,transparent_90deg_180deg)] bg-[length:24px_24px] p-4">
                {originalUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={originalUrl} alt="Uploaded original" className="max-h-full max-w-full object-contain" />
                ) : null}
              </div>
            </figure>

            {/* Result */}
            <figure className="overflow-hidden rounded-2xl border border-border bg-card">
              <figcaption className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span className="size-3.5 rounded-sm border border-border bg-background" aria-hidden />
                  Isolated
                </span>
                {result ? <span className="normal-case tracking-normal">{`${result.width} x ${result.height}`}</span> : null}
              </figcaption>
              <div className="relative flex aspect-square items-center justify-center bg-background p-4">
                {status === "processing" ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <Loader2 className="size-7 animate-spin text-primary" />
                    <p className="text-sm font-medium text-foreground">{progress.stage || "Processing"}</p>
                    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${Math.max(6, Math.round(progress.ratio * 100))}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">First run downloads the model, so give it a moment.</p>
                  </div>
                ) : result ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={result.url} alt="Subject isolated on white background" className="max-h-full max-w-full object-contain shadow-sm" />
                ) : status === "error" ? (
                  <div className="flex flex-col items-center gap-2 px-6 text-center">
                    <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                      <X className="size-5" />
                    </span>
                    <p className="text-sm text-muted-foreground text-pretty">{error}</p>
                  </div>
                ) : null}
              </div>
            </figure>
          </div>

          {/* Padding controls */}
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Padding</p>
              <p className="text-xs text-muted-foreground">Whitespace kept around the subject.</p>
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Padding amount">
              {PADDING_OPTIONS.map((opt) => {
                const active = padding === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => changePadding(opt.value)}
                    disabled={status === "processing"}
                    aria-pressed={active}
                    className={`min-h-11 rounded-lg border px-4 text-sm font-medium transition-colors disabled:opacity-50 ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:bg-accent"
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={download} disabled={!result || status === "processing"} size="lg" className="flex-1">
              <Download className="size-4" />
              Download PNG
              {result ? <span className="text-primary-foreground/70">{`· ${formatBytes(result.bytes)}`}</span> : null}
            </Button>
            <Button onClick={reset} variant="outline" size="lg" className="flex-1 sm:flex-none">
              <RotateCcw className="size-4" />
              New image
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
