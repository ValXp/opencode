import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { CodexUsage } from "@opencode-ai/schema/codex-usage"
import { TestClock } from "effect/testing"
import { createCodexUsage, makeCache, parseCodexUsage } from "../src/codex-usage"
import { it } from "./lib/effect"

const payload = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 2000000000 },
    secondary_window: null,
  },
  credits: { balance: "private" },
}

function account(accountID = "account-a", key: string = crypto.randomUUID()) {
  return { key, access: "access-secret", accountID }
}

describe("Codex usage", () => {
  it.effect("shares single-flight quota reads across locations for the same account", () =>
    Effect.gen(function* () {
      const current = account()
      const cache = makeCache()
      const calls = { fetch: 0, resolve: 0 }
      const location = () =>
        createCodexUsage({
          cache,
          current: Effect.succeed(current),
          resolve: () =>
            Effect.sync(() => {
              calls.resolve++
              return current
            }),
          fetch: async () => {
            calls.fetch++
            return Response.json(payload)
          },
        })
      const first = location()
      const second = location()
      const results = yield* Effect.all([first(), second()], { concurrency: "unbounded" })
      expect(results.map((result) => result.status)).toEqual(["fresh", "fresh"])
      expect(calls).toEqual({ fetch: 1, resolve: 1 })
      expect(cache.entries.size).toBe(1)
    }),
  )

  it.effect("bounds process cache entries across accounts", () =>
    Effect.gen(function* () {
      const cache = makeCache(2)
      yield* Effect.forEach(["a", "b", "c"], (id) => {
        const current = account(`account-${id}`, `key-${id}`)
        return createCodexUsage({
          cache,
          current: Effect.succeed(current),
          resolve: () => Effect.succeed(current),
          fetch: async () => Response.json(payload),
        })()
      })
      expect(cache.entries.size).toBe(2)
    }),
  )

  test("keeps a valid secondary window when the primary is missing or malformed", () => {
    const result = parseCodexUsage(
      {
        ...payload,
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: "changed schema",
          secondary_window: { used_percent: 100, limit_window_seconds: 604800 },
        },
      },
      1000,
    )
    expect(result?.windows).toEqual([{ kind: "secondary", remainingPercent: 0, windowSeconds: 604800 }])
    expect(result?.limitReached).toBe(true)
  })

  it.effect("does not reuse cached quota after reconnecting the same account", () =>
    Effect.gen(function* () {
      const state = { current: account(), calls: 0 }
      const read = createCodexUsage({
        current: Effect.sync(() => state.current),
        resolve: () => Effect.succeed(state.current),
        fetch: async () => {
          state.calls++
          return state.calls === 1 ? Response.json(payload) : new Response(null, { status: 401 })
        },
      })
      expect((yield* read()).status).toBe("fresh")
      state.current = account()
      expect(yield* read()).toEqual({ status: "unknown", windows: [] })
      expect(state.calls).toBe(2)
    }),
  )

  test("projects only validated quota fields and computes remaining/reset", () => {
    expect(parseCodexUsage(payload, 1000)).toEqual({
      status: "fresh",
      updatedAt: 1000,
      planType: "plus",
      allowed: true,
      limitReached: false,
      windows: [{ kind: "primary", remainingPercent: 73, windowSeconds: 18000, resetAt: 2000000000000 }],
    })
    expect(parseCodexUsage(null, 1000)).toBeUndefined()
    expect(Schema.encodeSync(CodexUsage.Info)({ status: "unknown", windows: [], updatedAt: undefined })).toEqual({
      status: "unknown",
      windows: [],
    })
    expect(parseCodexUsage({ rate_limit: {} }, 1000)).toBeUndefined()
    for (const used_percent of [-1, 101, NaN, Infinity, "20"]) {
      expect(
        parseCodexUsage(
          {
            ...payload,
            rate_limit: { ...payload.rate_limit, primary_window: { used_percent, limit_window_seconds: 18000 } },
          },
          1000,
        )?.windows,
      ).toEqual([])
    }
    expect(
      parseCodexUsage(
        {
          ...payload,
          rate_limit: {
            ...payload.rate_limit,
            primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 20 },
          },
        },
        1000,
      )?.windows[0]?.resetAt,
    ).toBe(21000)
  })

  it.effect("coalesces reads, caches failures and bounds stale retention", () =>
    Effect.gen(function* () {
      const current = account()
      const calls = { fetch: 0, resolve: 0, fail: false }
      const read = createCodexUsage({
        current: Effect.succeed(current),
        resolve: () =>
          Effect.sync(() => {
            calls.resolve++
            return current
          }),
        fetch: async (url, init) => {
          calls.fetch++
          expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
          expect(init.redirect).toBe("error")
          expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("account-a")
          expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-secret")
          return calls.fail ? new Response("private upstream error", { status: 503 }) : Response.json(payload)
        },
      })
      const results = yield* Effect.all([read(), read(), read()], { concurrency: "unbounded" })
      expect(results.every((x) => x.status === "fresh")).toBe(true)
      expect(calls.fetch).toBe(1)
      expect(calls.resolve).toBe(1)
      calls.fail = true
      yield* TestClock.adjust(60001)
      expect((yield* read()).status).toBe("stale")
      yield* read()
      expect(calls.fetch).toBe(2)
      yield* TestClock.adjust(15 * 60000)
      expect(yield* read()).toEqual({ status: "unknown", windows: [] })
    }),
  )

  it.effect("times out hung requests and backs off OAuth failures", () =>
    Effect.gen(function* () {
      const current = account()
      const calls = { resolve: 0 }
      const read = createCodexUsage({
        current: Effect.succeed(current),
        resolve: () =>
          Effect.sync(() => {
            calls.resolve++
            return current
          }),
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          }),
      })
      const pending = yield* read().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* TestClock.adjust(10001)
      expect((yield* Fiber.join(pending)).status).toBe("unknown")
      yield* read()
      expect(calls.resolve).toBe(1)
      const failed = createCodexUsage({ current: Effect.succeed(current), resolve: () => Effect.fail("private error") })
      expect(yield* failed()).toEqual({ status: "unknown", windows: [] })
    }),
  )

  it.effect("discards in-flight results on logout and account switching", () =>
    Effect.gen(function* () {
      const state: { current: ReturnType<typeof account> | undefined; finish?: () => void } = { current: account() }
      const read = createCodexUsage({
        current: Effect.sync(() => state.current),
        resolve: () => Effect.succeed(state.current),
        fetch: () =>
          new Promise<Response>((resolve) => {
            state.finish = () => resolve(Response.json(payload))
          }),
      })
      const key = state.current?.key ?? ""
      const pending = yield* read().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      state.current = account("account-b", key)
      state.finish?.()
      expect(yield* Fiber.join(pending)).toEqual({ status: "unknown", windows: [] })
      state.current = undefined
      expect(yield* read()).toEqual({ status: "unsupported", windows: [] })
    }),
  )

  it.effect("does not resolve or fetch without a supported account source", () =>
    Effect.gen(function* () {
      const read = createCodexUsage({
        current: Effect.succeed(undefined),
        resolve: () => Effect.die("must not resolve"),
        fetch: async () => {
          throw new Error("must not fetch")
        },
      })
      expect((yield* read()).status).toBe("unsupported")
    }),
  )
})
