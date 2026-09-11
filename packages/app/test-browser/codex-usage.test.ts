import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createCodexUsageState,
  createSharedCodexUsageState,
  invalidateCodexUsage,
  supportsCodexUsage,
} from "../src/utils/codex-usage"

test("header and Settings share requests and retain the reader until the last consumer leaves", async () => {
  let requests = 0
  const listeners = new Set<() => void>()
  const source = () => ({
    server: { url: "http://shared", username: "user", password: "test" },
    directory: "/project",
    subscribe: (invalidate: () => void) => {
      listeners.add(invalidate)
      return () => {
        listeners.delete(invalidate)
      }
    },
  })
  const fetch = async () => {
    requests++
    return Response.json({ data: { status: "fresh", updatedAt: Date.now(), windows: [] } })
  }
  const mount = (directory = "/project") =>
    createRoot((dispose) => ({
      state: createSharedCodexUsageState(() => ({ ...source(), directory }), fetch),
      dispose,
    }))
  const header = mount()
  const settings = mount()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toBe(1)
  expect(listeners.size).toBe(1)
  expect(header.state.usage).toBe(settings.state.usage)
  header.dispose()
  invalidateCodexUsage()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toBe(2)
  expect(settings.state.capable).toBe(true)
  const other = mount("/other")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toBe(3)
  expect(listeners.size).toBe(2)
  other.dispose()
  settings.dispose()
  expect(listeners.size).toBe(0)
  invalidateCodexUsage()
  expect(requests).toBe(3)
})

test("desktop rendering never probes the served-web quota capability", async () => {
  let requests = 0
  const setup = createRoot((dispose) => ({
    state: createCodexUsageState(
      () =>
        supportsCodexUsage("desktop") ? { server: { url: "http://localhost" }, subscribe: () => () => {} } : undefined,
      async () => {
        requests++
        return Response.json({ data: { status: "fresh", windows: [] } })
      },
    ),
    dispose,
  }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toBe(0)
  expect(setup.state.capable).toBe(false)
  setup.dispose()
})

test("clears usage on server/account changes and ignores late responses after cleanup", async () => {
  const requests: { url: string; resolve: (response: Response) => void; signal?: AbortSignal | null }[] = []
  const listeners = new Set<() => void>()
  const setup = createRoot((dispose) => {
    const [selection, select] = createStore({ url: "http://first", enabled: true })
    const state = createCodexUsageState(
      () =>
        selection.enabled
          ? {
              server: { url: selection.url },
              subscribe: (invalidate) => {
                listeners.add(invalidate)
                return () => {
                  listeners.delete(invalidate)
                }
              },
            }
          : undefined,
      (url, init) =>
        new Promise((resolve) => {
          requests.push({ url: String(url), resolve, signal: init?.signal })
        }),
    )
    return { state, select, dispose }
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  expect(requests[0]?.url).toBe("http://first/api/integration/openai/usage")
  setup.select("url", "http://second")
  await settle()
  expect(requests[0]?.signal?.aborted).toBe(true)
  requests[0]?.resolve(Response.json({ data: { status: "fresh", windows: [] } }))
  await settle()
  expect(setup.state.usage).toBeUndefined()
  expect(setup.state.capable).toBe(false)
  requests[1]?.resolve(Response.json({ data: { status: "fresh", updatedAt: 123, windows: [] } }))
  await settle()
  expect(setup.state.usage?.updatedAt).toBe(123)
  expect(setup.state.capable).toBe(true)
  invalidateCodexUsage()
  expect(setup.state.usage).toBeUndefined()
  await settle()
  expect(requests).toHaveLength(3)
  requests[2]?.resolve(Response.json({ data: { status: "fresh", updatedAt: 456, windows: [] } }))
  await settle()
  expect(setup.state.usage?.updatedAt).toBe(456)
  listeners.forEach((invalidate) => invalidate())
  expect(setup.state.usage).toBeUndefined()
  await settle()
  requests[3]?.resolve(Response.json({ data: { status: "unsupported", windows: [] } }))
  await settle()
  expect(setup.state.usage?.status).toBe("unsupported")
  setup.select("enabled", false)
  await settle()
  expect(setup.state.usage).toBeUndefined()
  expect(listeners.size).toBe(0)
  const before = requests.length
  document.dispatchEvent(new Event("visibilitychange"))
  expect(requests.length).toBe(before)
  setup.select("enabled", true)
  await settle()
  setup.dispose()
  requests.at(-1)?.resolve(Response.json({ data: { status: "fresh", windows: [] } }))
  await settle()
  expect(setup.state.usage).toBeUndefined()
  expect(listeners.size).toBe(0)
})
