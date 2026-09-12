import { Schema } from "effect"
import { type Accessor, createEffect, createMemo, createRoot, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { CodexUsage } from "@opencode-ai/schema/codex-usage"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

// The app's pinned compatibility client predates this current-protocol endpoint.
const Response = Schema.Struct({ data: CodexUsage.Info })

export async function readCodexUsage(input: {
  server: ServerConnection.HttpBase
  directory?: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  signal: AbortSignal
}) {
  const url = new URL(`${input.server.url.replace(/\/$/, "")}/api/integration/openai/usage`)
  if (input.directory) url.searchParams.set("location[directory]", input.directory)
  // Native browser fetch must not receive the options object as its receiver.
  const fetch = input.fetch
  const response = await fetch(url.href, {
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({ username: input.server.username, password: input.server.password })}`,
        }
      : undefined,
    signal: input.signal,
    cache: "no-store",
  })
  if (response.status === 404) return
  if (!response.ok) throw new Error("Quota unavailable")
  return Schema.decodeUnknownSync(Response)(await response.json()).data
}

export function codexUsageStale(usage: CodexUsage.Info, now: number) {
  return (
    usage.status === "stale" ||
    (usage.updatedAt != null && now - usage.updatedAt > 90000) ||
    usage.windows.some((window) => window.resetAt != null && window.resetAt <= now)
  )
}

export function supportsCodexUsage(platform: "web" | "desktop") {
  return platform === "web"
}

const invalidated = "opencode:codex-usage-invalidated"

type UsageSource = Parameters<typeof createCodexUsageState>[0]
type UsageFetch = Parameters<typeof createCodexUsageState>[1]

// Share one polling owner across the header and Settings, releasing it with the last consumer.
type UsageReader = {
  state: ReturnType<typeof createCodexUsageState>
  dispose: () => void
  refs: number
}
const readers = new WeakMap<UsageFetch, Map<string, UsageReader>>()

export function createSharedCodexUsageState(source: UsageSource, fetch: UsageFetch) {
  const current = createMemo(() => {
    const input = source()
    if (!input) return
    const cache = readers.get(fetch) ?? new Map<string, UsageReader>()
    readers.set(fetch, cache)
    const key = JSON.stringify([input.server.url, input.server.username, input.server.password, input.directory])
    const entry =
      cache.get(key) ??
      createRoot((dispose) => ({
        state: createCodexUsageState(() => input, fetch),
        dispose,
        refs: 0,
      }))
    cache.set(key, entry)
    entry.refs++
    onCleanup(() => {
      if (--entry.refs !== 0) return
      entry.dispose()
      cache.delete(key)
    })
    return entry.state
  })
  return {
    get capable() {
      return current()?.capable ?? false
    },
    get usage() {
      return current()?.usage
    },
    get now() {
      return current()?.now ?? Date.now()
    },
  }
}

export function invalidateCodexUsage() {
  window.dispatchEvent(new Event(invalidated))
}

/** Owns polling and invalidation; a new server/connection must never inherit the old display. */
export function createCodexUsageState(
  source: Accessor<
    | {
        server: ServerConnection.HttpBase
        directory?: string
        subscribe: (invalidate: () => void) => () => void
      }
    | undefined
  >,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) {
  const [state, setState] = createStore<{ capable: boolean; usage?: CodexUsage.Info; now: number }>({
    capable: false,
    now: Date.now(),
  })
  createEffect(() => {
    const current = source()
    setState({ capable: false, usage: undefined })
    if (!current) return
    const request: { controller?: AbortController } = {}
    const load = () => {
      setState("now", Date.now())
      request.controller?.abort()
      const controller = new AbortController()
      request.controller = controller
      void readCodexUsage({
        server: current.server,
        directory: current.directory,
        fetch,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      })
        .then((usage) => {
          if (controller.signal.aborted) return
          if (!usage) {
            setState({ capable: false, usage: undefined })
            return
          }
          setState({ capable: true, usage, now: Date.now() })
        })
        .catch(() => {
          if (!controller.signal.aborted && state.capable) setState("usage", { status: "unknown", windows: [] })
        })
    }
    load()
    const timer = setInterval(() => {
      setState("now", Date.now())
      if (document.visibilityState !== "hidden") load()
    }, 60000)
    const visible = () => {
      if (document.visibilityState !== "hidden") load()
    }
    const invalidate = () => {
      setState("usage", undefined)
      visible()
    }
    document.addEventListener("visibilitychange", visible)
    window.addEventListener(invalidated, invalidate)
    const unsubscribe = current.subscribe(invalidate)
    onCleanup(() => {
      request.controller?.abort()
      clearInterval(timer)
      unsubscribe()
      document.removeEventListener("visibilitychange", visible)
      window.removeEventListener(invalidated, invalidate)
    })
  })
  return state
}
