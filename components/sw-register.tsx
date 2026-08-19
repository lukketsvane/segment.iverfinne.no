"use client"

import { useEffect } from "react"

/**
 * Registers the service worker (public/sw.js) after load. It caches the ~44MB
 * model assets and hashed static chunks so repeat visits — and home-screen
 * launches — start instantly and work offline.
 */
export function SWRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return
    if (!("serviceWorker" in navigator)) return
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {})
    }
    if (document.readyState === "complete") {
      register()
      return
    }
    window.addEventListener("load", register, { once: true })
    return () => window.removeEventListener("load", register)
  }, [])
  return null
}
