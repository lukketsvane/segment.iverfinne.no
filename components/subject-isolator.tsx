"use client"

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Download, Plus, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { composeIsolated, removeCutout, type Cutout, type IsolateResult } from "@/lib/isolate"

type Item = {
  id: string
  name: string
  file: File
  cutout: Cutout | null
  result: IsolateResult | null
  status: "loading" | "ready" | "error"
}

const MIN_SUBJECTS = 1
const MAX_SUBJECTS = 5
const MIN_PADDING = 0
const MAX_PADDING = 24
const DEFAULT_PADDING = 12
const TAP_SLOP = 10

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function SubjectIsolator() {
  const [items, setItems] = useState<Item[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [padding, setPadding] = useState(DEFAULT_PADDING)
  const [subjectCount, setSubjectCount] = useState(1)
  const [hudAxis, setHudAxis] = useState<"x" | "y" | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const itemsRef = useRef<Item[]>(items)
  const paddingRef = useRef(padding)
  const subjectCountRef = useRef(subjectCount)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const dragRef = useRef<{
    startX: number
    startY: number
    axis: "x" | "y" | null
    startPadding: number
    startCount: number
  } | null>(null)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const updateItem = useCallback((id: string, patch: Partial<Item>) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it
        if (patch.result && it.result && it.result.url !== patch.result.url) {
          URL.revokeObjectURL(it.result.url)
        }
        return { ...it, ...patch }
      }),
    )
  }, [])

  const processItem = useCallback(
    async (item: Item) => {
      try {
        const cutout = await removeCutout(item.file)
        updateItem(item.id, { cutout, status: "ready" })
        const result = await composeIsolated(cutout, {
          paddingPct: paddingRef.current,
          maxSubjects: subjectCountRef.current,
        })
        updateItem(item.id, { result })
      } catch {
        updateItem(item.id, { status: "error" })
      }
    },
    [updateItem],
  )

  const handleFiles = useCallback(
    (files: FileList | null | undefined) => {
      if (!files?.length) return
      const picked = Array.from(files).filter((f) => f.type.startsWith("image/"))
      if (!picked.length) return
      const newItems: Item[] = picked.map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name.replace(/\.[^.]+$/, ""),
        file,
        cutout: null,
        result: null,
        status: "loading",
      }))
      setItems((prev) => [...prev, ...newItems])
      setActiveId((prev) => prev ?? newItems[0].id)
      for (const item of newItems) {
        queueRef.current = queueRef.current.then(() => processItem(item))
      }
    },
    [processItem],
  )

  // The focused item recomposes live on every setting change (cheap, no ML);
  // the rest catch up once a gesture settles, via settleOthers below.
  useEffect(() => {
    paddingRef.current = padding
    subjectCountRef.current = subjectCount
    const active = items.find((it) => it.id === activeId)
    if (!active?.cutout) return
    let cancelled = false
    composeIsolated(active.cutout, { paddingPct: padding, maxSubjects: subjectCount }).then((result) => {
      if (!cancelled) updateItem(active.id, { result })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padding, subjectCount, activeId])

  const settleOthers = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.id === activeId || !item.cutout) continue
      composeIsolated(item.cutout, {
        paddingPct: paddingRef.current,
        maxSubjects: subjectCountRef.current,
      }).then((result) => updateItem(item.id, { result }))
    }
  }, [activeId, updateItem])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      axis: null,
      startPadding: paddingRef.current,
      startCount: subjectCountRef.current,
    }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
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

  const onPointerUp = useCallback(() => {
    const wasTap = dragRef.current?.axis == null
    dragRef.current = null
    setHudAxis(null)
    if (wasTap) {
      inputRef.current?.click()
      return
    }
    settleOthers()
  }, [settleOthers])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const removed = prev.find((it) => it.id === id)
      if (removed?.result) URL.revokeObjectURL(removed.result.url)
      const next = prev.filter((it) => it.id !== id)
      setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current))
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.result) URL.revokeObjectURL(item.result.url)
    }
    setItems([])
    setActiveId(null)
  }, [])

  const download = useCallback(() => {
    const active = items.find((it) => it.id === activeId)
    if (!active?.result) return
    const a = document.createElement("a")
    a.href = active.result.url
    a.download = `${active.name}-isolated.png`
    a.click()
  }, [items, activeId])

  const active = items.find((it) => it.id === activeId) ?? null

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />

      <div className="relative w-full">
        <div
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
          ) : active.result ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={active.result.url} alt="" className="max-h-full max-w-full object-contain" />
          ) : null}

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

        {items.length > 0 && (
          <div className="absolute -top-2 -right-2 flex gap-2">
            <Button
              onClick={download}
              disabled={!active?.result}
              aria-label="Download"
              variant="outline"
              size="icon"
              className="size-11 rounded-full border-border bg-card shadow-sm"
            >
              <Download className="size-4" />
            </Button>
            <Button
              onClick={clearAll}
              aria-label="Clear all"
              variant="outline"
              size="icon"
              className="size-11 rounded-full border-border bg-card shadow-sm"
            >
              <Trash2 className="size-4" />
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
              onClick={() => setActiveId(item.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveId(item.id)
              }}
              aria-label={item.name}
              aria-pressed={item.id === activeId}
              className={`relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-card ${
                item.id === activeId ? "border-foreground" : "border-border"
              }`}
            >
              {item.status === "loading" ? (
                <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
              ) : item.result ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.result.url} alt="" className="h-full w-full object-cover" />
              ) : null}
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
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
