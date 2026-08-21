"use client"

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Download, FolderDown, Plus, Share, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cutoutImage, preloadEngine } from "@/lib/engine/client"
import { compositeBlob, makeCutout, renderPreview, type Cutout, type IsolateOptions } from "@/lib/isolate"

type Item = {
  id: string
  name: string
  cutout: Cutout | null
  status: "loading" | "ready" | "error"
}

const MIN_SUBJECTS = 1
const MAX_SUBJECTS = 5
const MIN_PADDING = 0
const MAX_PADDING = 24
const DEFAULT_PADDING = 12
const TAP_SLOP = 10
const THUMB_SIZE = 112
const LONG_PRESS_MS = 450

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** Defers work off the interaction path; falls back where rIC is unavailable (iOS < 18). */
function runWhenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, { timeout: 2000 })
    return () => cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(callback, 300)
  return () => window.clearTimeout(handle)
}

export function SubjectIsolator() {
  const [items, setItems] = useState<Item[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [padding, setPadding] = useState(DEFAULT_PADDING)
  const [subjectCount, setSubjectCount] = useState(1)
  const [hudAxis, setHudAxis] = useState<"x" | "y" | null>(null)
  const [fetchProgress, setFetchProgress] = useState<number | null>(null)
  const [shareCapable, setShareCapable] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const inputRef = useRef<HTMLInputElement>(null)
  const padRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const thumbRefs = useRef(new Map<string, HTMLCanvasElement>())
  const itemsRef = useRef<Item[]>(items)
  const selectedIdsRef = useRef<Set<string>>(selectedIds)
  const paddingRef = useRef(padding)
  const subjectCountRef = useRef(subjectCount)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const exportRef = useRef<{ key: string; blob: Blob } | null>(null)
  const cancelExportIdleRef = useRef<(() => void) | null>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    axis: "x" | "y" | null
    startPadding: number
    startCount: number
  } | null>(null)

  const activeIdRef = useRef(activeId)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressFiredRef = useRef(false)

  useEffect(() => {
    itemsRef.current = items
  }, [items])
  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])
  paddingRef.current = padding
  subjectCountRef.current = subjectCount
  activeIdRef.current = activeId

  useEffect(() => {
    setShareCapable(typeof navigator !== "undefined" && typeof navigator.canShare === "function")
  }, [])

  // Model download progress (first visit only — assets are cached after).
  // Events arrive per resource from the worker; aggregate bytes and throttle
  // state updates to one per frame.
  const progressPartsRef = useRef(new Map<string, { current: number; total: number }>())
  const progressRafRef = useRef<number | null>(null)
  const onModelProgress = useCallback((key: string, current: number, total: number) => {
    if (!key.startsWith("fetch:")) return
    progressPartsRef.current.set(key, { current, total })
    if (progressRafRef.current != null) return
    progressRafRef.current = requestAnimationFrame(() => {
      progressRafRef.current = null
      let done = 0
      let all = 0
      for (const part of progressPartsRef.current.values()) {
        done += part.current
        all += part.total
      }
      setFetchProgress(all > 0 && done < all ? done / all : null)
    })
  }, [])

  // Warm the model during idle time so the first photo doesn't pay for the
  // download + session compile.
  useEffect(() => {
    const cancel = runWhenIdle(() => {
      preloadEngine(onModelProgress).catch(() => {})
    })
    return cancel
  }, [onModelProgress])

  const currentOptions = useCallback(
    (): IsolateOptions => ({ paddingPct: paddingRef.current, maxSubjects: subjectCountRef.current }),
    [],
  )

  const drawThumbs = useCallback(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    for (const item of itemsRef.current) {
      const canvas = thumbRefs.current.get(item.id)
      if (!item.cutout || !canvas) continue
      renderPreview(item.cutout, currentOptions(), canvas, Math.min(THUMB_SIZE * dpr, THUMB_SIZE * 2))
    }
  }, [currentOptions])

  const scheduleExport = useCallback(() => {
    cancelExportIdleRef.current?.()
    cancelExportIdleRef.current = runWhenIdle(() => {
      cancelExportIdleRef.current = null
      const active = itemsRef.current.find((it) => it.id === activeIdRef.current)
      if (!active?.cutout) return
      const opts = currentOptions()
      const key = `${active.id}:${opts.paddingPct}:${opts.maxSubjects}`
      if (exportRef.current?.key === key) return
      compositeBlob(active.cutout, opts).then(
        (blob) => {
          exportRef.current = { key, blob }
        },
        () => {},
      )
    })
  }, [currentOptions])

  const updateItem = useCallback((id: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }, [])

  const processItem = useCallback(
    async (id: string, file: File) => {
      try {
        const matte = await cutoutImage(file, onModelProgress)
        updateItem(id, { cutout: makeCutout(matte), status: "ready" })
      } catch {
        updateItem(id, { status: "error" })
      }
    },
    [onModelProgress, updateItem],
  )

  const handleFiles = useCallback(
    (files: FileList | null | undefined) => {
      if (!files?.length) return
      const picked = Array.from(files).filter((f) => f.type.startsWith("image/"))
      if (!picked.length) return
      const newItems: Item[] = picked.map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name.replace(/\.[^.]+$/, ""),
        cutout: null,
        status: "loading",
      }))
      setItems((prev) => [...prev, ...newItems])
      setActiveId((prev) => prev ?? newItems[0].id)
      newItems.forEach((item, index) => {
        const file = picked[index]
        queueRef.current = queueRef.current.then(() => processItem(item.id, file))
      })
    },
    [processItem],
  )

  // The focused item re-renders straight to canvas on every setting change —
  // pure draw calls, no encodes — so gesture frames stay cheap.
  useEffect(() => {
    const active = items.find((it) => it.id === activeId)
    const canvas = previewRef.current
    const pad = padRef.current
    if (!active?.cutout || !canvas || !pad) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    renderPreview(active.cutout, { paddingPct: padding, maxSubjects: subjectCount }, canvas, pad.clientWidth * dpr)
  }, [items, activeId, padding, subjectCount])

  // Thumbnails and the export blob refresh when the set of items or the active
  // item changes; during drags they catch up on settle instead.
  useEffect(() => {
    drawThumbs()
    scheduleExport()
  }, [items, activeId, drawThumbs, scheduleExport])

  const settle = useCallback(() => {
    drawThumbs()
    scheduleExport()
  }, [drawThumbs, scheduleExport])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      axis: null,
      startPadding: paddingRef.current,
      startCount: subjectCountRef.current,
    }
  }, [])

  // Pointer events can fire well above 60Hz on touch hardware; coalescing to one
  // update per animation frame keeps drags smooth.
  const rafRef = useRef<number | null>(null)
  const lastPointRef = useRef({ x: 0, y: 0 })

  const applyDrag = useCallback(() => {
    rafRef.current = null
    const d = dragRef.current
    if (!d) return
    const dx = lastPointRef.current.x - d.startX
    const dy = lastPointRef.current.y - d.startY
    if (!d.axis) {
      if (Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) return
      d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y"
      setHudAxis(d.axis)
    }
    if (d.axis === "x") {
      setPadding(Math.round(clamp(d.startPadding + dx / 8, MIN_PADDING, MAX_PADDING)))
    } else {
      setSubjectCount(Math.round(clamp(d.startCount - dy / 36, MIN_SUBJECTS, MAX_SUBJECTS)))
    }
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return
      lastPointRef.current = { x: e.clientX, y: e.clientY }
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(applyDrag)
    },
    [applyDrag],
  )

  const onPointerUp = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    const wasTap = dragRef.current?.axis == null
    dragRef.current = null
    setHudAxis(null)
    if (wasTap) {
      inputRef.current?.click()
      return
    }
    settle()
  }, [settle])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const removeItem = useCallback((id: string) => {
    thumbRefs.current.delete(id)
    setItems((prev) => {
      const next = prev.filter((it) => it.id !== id)
      setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current))
      return next
    })
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    thumbRefs.current.clear()
    exportRef.current = null
    setItems([])
    setActiveId(null)
    setSelectedIds(new Set())
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  // Tap-hold on a thumbnail enters multi-select; once active, plain taps on
  // other thumbnails toggle membership instead of changing the focused item.
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const startLongPress = useCallback(
    (id: string) => {
      longPressFiredRef.current = false
      cancelLongPress()
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null
        longPressFiredRef.current = true
        toggleSelected(id)
      }, LONG_PRESS_MS)
    },
    [cancelLongPress, toggleSelected],
  )

  const onThumbClick = useCallback(
    (id: string) => {
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false
        return
      }
      if (selectedIdsRef.current.size > 0) {
        toggleSelected(id)
      } else {
        setActiveId(id)
      }
    },
    [toggleSelected],
  )

  // Saving goes through the native share sheet on iOS (→ "Save Image" lands in
  // Photos); the composited blob is precomputed at idle so the tap can call
  // navigator.share while the user activation is still fresh.
  const exportActive = useCallback(async () => {
    const active = itemsRef.current.find((it) => it.id === activeIdRef.current)
    if (!active?.cutout) return
    const opts = currentOptions()
    const key = `${active.id}:${opts.paddingPct}:${opts.maxSubjects}`
    let blob = exportRef.current?.key === key ? exportRef.current.blob : null
    if (!blob) {
      blob = await compositeBlob(active.cutout, opts)
      exportRef.current = { key, blob }
    }
    const filename = `${active.name || "subject"}-isolated.png`
    if (typeof navigator.canShare === "function" && typeof navigator.share === "function") {
      const file = new File([blob], filename, { type: "image/png" })
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] })
          return
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return
          // fall through to plain download
        }
      }
    }
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }, [currentOptions])

  // Browsers throttle downloads fired back-to-back with no gap, so each
  // anchor click gets a brief stagger instead of all firing in one tick.
  // With an active selection this downloads only the selected items, then
  // exits selection mode; otherwise it downloads everything ready.
  const downloadAll = useCallback(async () => {
    const opts = currentOptions()
    const selected = selectedIdsRef.current
    const pool =
      selected.size > 0 ? itemsRef.current.filter((it) => selected.has(it.id)) : itemsRef.current
    const ready = pool.filter((it) => it.status === "ready" && it.cutout)
    for (let i = 0; i < ready.length; i++) {
      const item = ready[i]
      if (!item.cutout) continue
      const blob = await compositeBlob(item.cutout, opts)
      const filename = `${item.name || "subject"}-isolated.png`
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filename
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      if (i < ready.length - 1) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (selected.size > 0) clearSelection()
  }, [currentOptions, clearSelection])

  const active = items.find((it) => it.id === activeId) ?? null
  const readyCount = items.filter((it) => it.status === "ready").length
  const selectedCount = selectedIds.size

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />

      <div className="relative w-[min(100%,calc(100dvh-9rem))]">
        <div
          ref={padRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          tabIndex={0}
          role="button"
          aria-label="Add image"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click()
          }}
          className="relative flex aspect-square w-full touch-none select-none items-center justify-center overflow-hidden rounded-[2.75rem] border border-border bg-card focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {!active ? (
            <span className="flex size-16 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
              <Plus className="size-7" />
            </span>
          ) : active.status === "loading" ? (
            <span className="size-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          ) : active.status === "error" ? (
            <span className="flex size-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <X className="size-6" />
            </span>
          ) : (
            <canvas ref={previewRef} aria-hidden className="h-full w-full" />
          )}

          {/* first-run model download — thin, text-free progress line */}
          {fetchProgress != null && (
            <div className="pointer-events-none absolute inset-x-6 top-5 h-0.5 overflow-hidden rounded-full bg-foreground/15">
              <div
                className="h-full rounded-full bg-foreground/70"
                style={{ width: `${Math.round(fetchProgress * 100)}%` }}
              />
            </div>
          )}

          {/* vertical drag — subject count (1-5) */}
          <div
            className={`pointer-events-none absolute inset-y-6 right-5 flex flex-col-reverse items-center justify-center gap-2 transition-opacity duration-150 ${
              hudAxis === "y" ? "opacity-100" : "opacity-0"
            }`}
          >
            {Array.from({ length: MAX_SUBJECTS }).map((_, i) => (
              <span
                key={i}
                className={`size-2 rounded-full transition-colors ${i < subjectCount ? "bg-foreground" : "bg-foreground/20"}`}
              />
            ))}
          </div>

          {/* horizontal drag — padding */}
          <div
            className={`pointer-events-none absolute inset-x-6 bottom-5 h-1 overflow-hidden rounded-full bg-foreground/15 transition-opacity duration-150 ${
              hudAxis === "x" ? "opacity-100" : "opacity-0"
            }`}
          >
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-75"
              style={{ width: `${(padding / MAX_PADDING) * 100}%` }}
            />
          </div>
        </div>

        {/* Bare glyphs, lifted clear of the frame: the card's 2.75rem corner
            radius leaves empty space here, so they read as controls without a
            chrome circle competing with the image. Difference blending is what
            lets the circle go — a white glyph over a white photo would other-
            wise vanish, and it inverts to black instead. */}
        {items.length > 0 && (
          <div className="absolute -top-4 -right-1 flex gap-1">
            <Button
              onClick={exportActive}
              disabled={active?.status !== "ready"}
              aria-label={shareCapable ? "Share" : "Download"}
              variant="ghost"
              size="icon"
              className="size-11 bg-transparent text-white mix-blend-difference hover:bg-transparent"
            >
              {shareCapable ? <Share className="size-5" /> : <Download className="size-5" />}
            </Button>
            {selectedCount > 0 && (
              <Button
                onClick={clearSelection}
                aria-label="Cancel selection"
                variant="ghost"
                size="icon"
                className="size-11 bg-transparent text-white mix-blend-difference hover:bg-transparent"
              >
                <X className="size-5" />
              </Button>
            )}
            {items.length > 1 && (
              <Button
                onClick={downloadAll}
                disabled={selectedCount > 0 ? false : readyCount === 0}
                aria-label={selectedCount > 0 ? `Download ${selectedCount} selected` : "Download all"}
                variant="ghost"
                size="icon"
                className="size-11 bg-transparent text-white mix-blend-difference hover:bg-transparent"
              >
                <FolderDown className="size-5" />
              </Button>
            )}
            <Button
              onClick={clearAll}
              aria-label="Clear all"
              variant="ghost"
              size="icon"
              className="size-11 bg-transparent text-white mix-blend-difference hover:bg-transparent"
            >
              <Trash2 className="size-5" />
            </Button>
          </div>
        )}
      </div>

      {items.length > 1 && (
        <div className="flex w-full gap-2 overflow-x-auto pb-1">
          {items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onPointerDown={() => startLongPress(item.id)}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => onThumbClick(item.id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return
                if (selectedIds.size > 0) toggleSelected(item.id)
                else setActiveId(item.id)
              }}
              aria-label={item.name}
              aria-pressed={selectedIds.size > 0 ? selectedIds.has(item.id) : item.id === activeId}
              className={`relative flex size-14 shrink-0 select-none items-center justify-center overflow-hidden rounded-2xl border bg-card ${
                selectedIds.has(item.id) || item.id === activeId ? "border-foreground" : "border-border"
              }`}
            >
              {item.status === "loading" ? (
                <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
              ) : item.status === "error" ? (
                <X className="size-4 text-destructive" />
              ) : (
                <canvas
                  aria-hidden
                  className="h-full w-full"
                  ref={(el) => {
                    if (el) thumbRefs.current.set(item.id, el)
                    else thumbRefs.current.delete(item.id)
                  }}
                />
              )}
              {selectedIds.has(item.id) && (
                <div className="absolute inset-0 flex items-center justify-center bg-foreground/40">
                  <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-background">
                    <Check className="size-3.5" />
                  </span>
                </div>
              )}
              {selectedIds.size === 0 && (
                <button
                  type="button"
                  aria-label="Remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeItem(item.id)
                  }}
                  className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/80 text-foreground"
                >
                  <X className="size-2.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
