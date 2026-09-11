import { describe, expect } from "bun:test"
import { CodexUsage } from "@opencode-ai/core/codex-usage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Auth } from "../../src/auth"
import { makeLayer } from "../../src/plugin/openai/codex-usage"
import { type CodexOAuthCredential, resolveCodexOAuth } from "../../src/plugin/openai/codex"
import { it, testEffect } from "../lib/effect"

const authIt = testEffect(LayerNode.compile(Auth.node))

const usage = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 20, limit_window_seconds: 18000 },
    secondary_window: null,
  },
}

function oauth(accountId = "account-a", refresh = "refresh-a") {
  return new Auth.Oauth({
    type: "oauth",
    access: "access-a",
    refresh,
    expires: 200000,
    accountId,
  })
}

function fixture(
  initial: Auth.Info | undefined,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  now = () => 100000,
  cache = CodexUsage.makeCache(),
  refreshTimeoutMs?: number,
) {
  const state: { value: Auth.Info | undefined; writes: Auth.Info[] } = { value: initial, writes: [] }
  const auth = Layer.mock(Auth.Service)({
    get: () => Effect.succeed(state.value),
    connection: () => Effect.succeed({ info: state.value, generation: "1" }),
    set: (_key, value) =>
      Effect.sync(() => {
        state.value = value
        state.writes.push(value)
      }),
    updateOauth: (_key, expectedRefresh, value) =>
      Effect.sync(() => {
        if (state.value?.type !== "oauth" || state.value.refresh !== expectedRefresh) return false
        state.value = value
        state.writes.push(value)
        return true
      }),
  })
  const run = <A, E>(effect: Effect.Effect<A, E, CodexUsage.Service>) =>
    effect.pipe(Effect.provide(makeLayer({ fetch, now, cache, refreshTimeoutMs })), Effect.provide(auth))
  return { state, run }
}

describe("legacy Codex usage source", () => {
  it.effect("shares quota single-flight across location-scoped legacy sources", () => {
    const cache = CodexUsage.makeCache()
    const calls = { fetch: 0 }
    const fetch = async () => {
      calls.fetch++
      return Response.json(usage)
    }
    const first = fixture(oauth(), fetch, () => 100000, cache)
    const second = fixture(oauth(), fetch, () => 100000, cache)
    return Effect.all(
      [
        first.run(Effect.flatMap(CodexUsage.Service, (service) => service.read())),
        second.run(Effect.flatMap(CodexUsage.Service, (service) => service.read())),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          expect(results.map((result) => result.status)).toEqual(["fresh", "fresh"])
          expect(calls.fetch).toBe(1)
        }),
      ),
    )
  })

  it.effect("shares expired-token refresh and usage across location-scoped sources", () => {
    const cache = CodexUsage.makeCache()
    const calls = { token: 0, usage: 0 }
    const state = { value: oauth("account-a", "refresh-old") }
    const auth = Layer.mock(Auth.Service)({
      get: () => Effect.succeed(state.value),
      connection: () => Effect.succeed({ info: state.value, generation: "expired-connection" }),
      updateOauth: (_key, expectedRefresh, value) =>
        Effect.sync(() => {
          if (state.value.refresh !== expectedRefresh) return false
          state.value = value
          return true
        }),
    })
    const fetch = async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/oauth/token")) {
        calls.token++
        return Response.json({
          id_token: "",
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        })
      }
      calls.usage++
      return Response.json(usage)
    }
    const read = () =>
      Effect.flatMap(CodexUsage.Service, (service) => service.read()).pipe(
        Effect.provide(makeLayer({ fetch, now: () => 300000, cache })),
        Effect.provide(auth),
      )
    return Effect.all([read(), read()], { concurrency: "unbounded" }).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          expect(results.map((result) => result.status)).toEqual(["fresh", "fresh"])
          expect(calls).toEqual({ token: 1, usage: 1 })
          expect(cache.entries.size).toBe(1)
          expect([...cache.entries.keys()][0]).toBe("expired-connection\0account-a")
        }),
      ),
    )
  })

  authIt.instance("fetches fresh usage after logout and reconnect of the same account", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* Effect.gen(function* () {
        const calls = { usage: 0 }
        const read = Effect.flatMap(CodexUsage.Service, (service) => service.read()).pipe(
          Effect.provide(
            makeLayer({
              now: () => 100000,
              fetch: async () => {
                calls.usage++
                return Response.json({
                  ...usage,
                  rate_limit: {
                    ...usage.rate_limit,
                    primary_window: { used_percent: calls.usage * 10, limit_window_seconds: 18000 },
                  },
                })
              },
            }),
          ),
        )

        yield* auth.set("openai", oauth())
        expect((yield* read).windows[0]?.remainingPercent).toBe(90)
        yield* auth.remove("openai")
        yield* auth.set("openai", oauth())
        expect((yield* read).windows[0]?.remainingPercent).toBe(80)
        expect(calls.usage).toBe(2)
      }).pipe(Effect.ensuring(auth.remove("openai").pipe(Effect.ignore)))
    }),
  )

  it.effect("reads the authoritative legacy OAuth account", () => {
    const test = fixture(oauth(), async (url, init) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-a")
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-a")
      return Response.json(usage)
    })
    return test
      .run(Effect.flatMap(CodexUsage.Service, (service) => service.read()))
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result.status).toBe("fresh"))))
  })

  it.effect("uses only legacy auth when current credentials differ or legacy auth is removed", () => {
    const test = fixture(new Auth.Api({ type: "api", key: "legacy-api-key" }), async () => {
      throw new Error("must not fetch")
    })
    return test.run(
      Effect.gen(function* () {
        const service = yield* CodexUsage.Service
        expect(yield* service.read()).toEqual({ status: "unsupported", windows: [] })
        test.state.value = oauth("legacy-account", "legacy-refresh")
        test.state.value = undefined
        expect(yield* service.read()).toEqual({ status: "unsupported", windows: [] })
      }),
    )
  })

  it.effect("coalesces refresh with model traffic and does not restore OAuth after logout", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const calls = { token: 0, usage: 0 }
      const test = fixture(
        oauth("account-a", "refresh-old"),
        async (url) => {
          if (String(url).endsWith("/oauth/token")) {
            calls.token++
            await Effect.runPromise(Deferred.await(release))
            return Response.json({
              id_token: "",
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
            })
          }
          calls.usage++
          return Response.json(usage)
        },
        () => 300000,
      )
      const read = test.run(Effect.flatMap(CodexUsage.Service, (service) => service.read())).pipe(Effect.forkScoped)
      const model = Effect.promise(() =>
        resolveCodexOAuth({
          get: async () => (test.state.value?.type === "oauth" ? test.state.value : undefined),
          set: async (expectedRefresh, value) => {
            if (test.state.value?.type !== "oauth" || test.state.value.refresh !== expectedRefresh) return false
            test.state.value = new Auth.Oauth({ type: "oauth", ...value })
            return true
          },
          fetch: async (url, init) => {
            if (!String(url).endsWith("/oauth/token")) throw new Error("unexpected request")
            calls.token++
            await Effect.runPromise(Deferred.await(release))
            return Response.json({
              id_token: "",
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
            })
          },
          now: () => 300000,
        }),
      ).pipe(Effect.forkScoped)
      const readFiber = yield* read
      const modelFiber = yield* model
      yield* Effect.yieldNow
      test.state.value = undefined
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(readFiber)).status).toBe("unknown")
      expect(yield* Fiber.join(modelFiber)).toBeUndefined()
      expect(calls.token).toBe(1)
      expect(calls.usage).toBe(0)
      expect(test.state.value).toBeUndefined()
    }),
  )

  it.live("bounds a hung quota refresh and allows later model traffic to retry", () =>
    Effect.promise(async () => {
      const state = { value: oauth("account-timeout", "refresh-timeout") }
      let tokenCalls = 0
      const get = async () => state.value
      const set = async (expectedRefresh: string, value: CodexOAuthCredential) => {
        if (state.value.refresh !== expectedRefresh) return false
        state.value = new Auth.Oauth({ type: "oauth", ...value })
        return true
      }
      const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        tokenCalls++
        if (tokenCalls === 1) return new Promise<Response>(() => init?.signal?.addEventListener("abort", () => {}))
        return Response.json({
          id_token: "",
          access_token: "access-retried",
          refresh_token: "refresh-retried",
          expires_in: 3600,
        })
      }
      const quota = resolveCodexOAuth({ get, set, fetch, now: () => 300000, refreshTimeoutMs: 10 })
      await expect(quota).rejects.toThrow("Token refresh timed out")
      const model = await resolveCodexOAuth({ get, set, fetch, now: () => 300000, refreshTimeoutMs: 1000 })
      expect(model?.access).toBe("access-retried")
      expect(tokenCalls).toBe(2)
    }),
  )

  it.live("bounds a hung initial credential read before creating single-flight state", () =>
    Effect.promise(async () => {
      let reads = 0
      const credential = oauth("account-initial-read", "refresh-initial-read")
      const input = {
        get: async () => {
          reads++
          if (reads === 1) return new Promise<Auth.Oauth>(() => {})
          return credential
        },
        set: async () => true,
        fetch: async () => {
          throw new Error("fresh credentials should not refresh")
        },
        now: () => 100000,
      }
      await expect(resolveCodexOAuth({ ...input, refreshTimeoutMs: 10 })).rejects.toThrow("Token refresh timed out")
      expect((await resolveCodexOAuth({ ...input, refreshTimeoutMs: 1000 }))?.access).toBe("access-a")
      expect(reads).toBe(2)
    }),
  )

  it.live("clears single-flight when the credential commit hangs", () =>
    Effect.promise(async () => {
      const state = { value: oauth("account-hung-set", "refresh-hung-set") }
      let tokenCalls = 0
      let setCalls = 0
      const input = {
        get: async () => state.value,
        set: async (_expectedRefresh: string, value: CodexOAuthCredential) => {
          setCalls++
          if (setCalls === 1) return new Promise<boolean>(() => {})
          state.value = new Auth.Oauth({ type: "oauth", ...value })
          return true
        },
        fetch: async () => {
          tokenCalls++
          return Response.json({
            id_token: "",
            access_token: `access-${tokenCalls}`,
            refresh_token: `refresh-${tokenCalls}`,
            expires_in: 3600,
          })
        },
        now: () => 300000,
      }
      await expect(resolveCodexOAuth({ ...input, refreshTimeoutMs: 10 })).rejects.toThrow("Token refresh timed out")
      const retried = await resolveCodexOAuth({ ...input, refreshTimeoutMs: 1000 })
      expect(retried?.access).toBe("access-2")
      expect({ tokenCalls, setCalls }).toEqual({ tokenCalls: 2, setCalls: 2 })
    }),
  )

  it.live("does not commit when a delayed setter resumes after the deadline", () =>
    Effect.promise(async () => {
      const state = { value: oauth("account-delayed-set", "refresh-delayed-set") }
      let release!: () => void
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pending = resolveCodexOAuth({
        get: async () => state.value,
        set: async (_expectedRefresh, value, commit) => {
          entered()
          await waiting
          if (commit.signal.aborted || Date.now() >= commit.deadline) return false
          state.value = new Auth.Oauth({ type: "oauth", ...value })
          return true
        },
        fetch: async () =>
          Response.json({
            id_token: "",
            access_token: "access-too-late",
            refresh_token: "refresh-too-late",
            expires_in: 3600,
          }),
        now: () => 300000,
        refreshTimeoutMs: 10,
      })
      await ready
      await expect(pending).rejects.toThrow("Token refresh timed out")
      release()
      await Promise.resolve()
      expect(state.value.refresh).toBe("refresh-delayed-set")
      expect(state.value.access).toBe("access-a")
    }),
  )

  it.effect("rejects logout and account replacement after refresh pre-check but before commit", () =>
    Effect.promise(async () => {
      for (const replacement of [undefined, oauth("account-b", "refresh-b")]) {
        let value: Auth.Oauth | undefined = oauth("account-a", "refresh-old")
        const result = await resolveCodexOAuth({
          get: async () => value,
          set: async (expectedRefresh, next) => {
            // Simulate logout/replacement after resolveCodexOAuth's latest read.
            value = replacement
            if (!value || value.refresh !== expectedRefresh) return false
            value = new Auth.Oauth({ type: "oauth", ...next })
            return true
          },
          fetch: async () =>
            Response.json({
              id_token: "",
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
            }),
          now: () => 300000,
        })
        expect(result).toBeUndefined()
        if (replacement) expect(value).toEqual(replacement)
        else expect(value).toBeUndefined()
      }
    }),
  )

  it.effect("invalidates cached usage when the legacy OAuth connection is replaced", () => {
    const calls = { usage: 0 }
    const test = fixture(oauth(), async () => {
      calls.usage++
      return calls.usage === 1 ? Response.json(usage) : new Response(null, { status: 503 })
    })
    return test.run(
      Effect.gen(function* () {
        const service = yield* CodexUsage.Service
        expect((yield* service.read()).status).toBe("fresh")
        test.state.value = oauth("account-b", "refresh-b")
        expect(yield* service.read()).toEqual({ status: "unknown", windows: [] })
        expect(calls.usage).toBe(2)
      }),
    )
  })
})
