import { expect, test } from "bun:test"
import { codexUsageStale, readCodexUsage, supportsCodexUsage } from "./codex-usage"
import { detectServerProtocol } from "./server-protocol"

test("enables quota for the hybrid server even though protocol detection selects v1", async () => {
  const protocol = await detectServerProtocol(
    { url: "http://localhost" },
    Object.assign(
      async (input: string | URL | Request) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname
        if (path === "/global/health") return Response.json({ healthy: true })
        if (path === "/api/health") return Response.json({ pid: 1 })
        return new Response(null, { status: 404 })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  expect(protocol).toBe("v1")
  expect(supportsCodexUsage("web")).toBe(true)
  expect(supportsCodexUsage("desktop")).toBe(false)
})

test("reads only the sanitized server endpoint with server authentication", async () => {
  const usage = { status: "fresh", windows: [{ kind: "primary", remainingPercent: 73, windowSeconds: 18000 }] } as const
  const result = await readCodexUsage({
    server: { url: "http://localhost:4096/", username: "user", password: "server-password" },
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      expect(url).toBe("http://localhost:4096/api/integration/openai/usage")
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${btoa("user:server-password")}`)
      expect(new Headers(init?.headers).has("ChatGPT-Account-Id")).toBe(false)
      expect(init?.cache).toBe("no-store")
      return Response.json({ data: usage })
    },
  })
  expect(result).toEqual(usage)
})

test("rejects unavailable or malformed server responses", async () => {
  for (const response of [
    new Response("private", { status: 401 }),
    Response.json({ data: { status: "fresh", windows: [{ remainingPercent: 200 }] } }),
  ]) {
    await expect(
      readCodexUsage({
        server: { url: "http://localhost" },
        fetch: async () => response,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeDefined()
  }
})

test("treats a missing endpoint as an unsupported server capability", async () => {
  expect(
    await readCodexUsage({
      server: { url: "http://localhost" },
      fetch: async () => new Response(null, { status: 404 }),
      signal: new AbortController().signal,
    }),
  ).toBeUndefined()
})

test("uses the selected directory for location-scoped OAuth resolution", async () => {
  await readCodexUsage({
    server: { url: "http://localhost" },
    directory: "/tmp/opencode/project with spaces",
    signal: new AbortController().signal,
    fetch: async (url) => {
      expect(new URL(url).searchParams.get("location[directory]")).toBe("/tmp/opencode/project with spaces")
      return Response.json({ data: { status: "unknown", windows: [] } })
    },
  })
})

test("does not present elapsed reset windows or old observations as live quota", () => {
  expect(codexUsageStale({ status: "fresh", updatedAt: 1000, windows: [] }, 2000)).toBe(false)
  expect(codexUsageStale({ status: "fresh", updatedAt: 1000, windows: [] }, 92000)).toBe(true)
  expect(codexUsageStale({ status: "stale", updatedAt: 1000, windows: [] }, 2000)).toBe(true)
  expect(
    codexUsageStale(
      {
        status: "fresh",
        updatedAt: 1000,
        windows: [{ kind: "primary", remainingPercent: 0, windowSeconds: 18000, resetAt: 2000 }],
      },
      2000,
    ),
  ).toBe(true)
})
