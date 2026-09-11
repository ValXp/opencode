export * as CodexUsage from "./codex-usage"

import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Info } from "@opencode-ai/schema/codex-usage"
import { Credential } from "./credential"
import { Integration } from "./integration"
import { makeLocationNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"

export { Info, Window } from "@opencode-ai/schema/codex-usage"

const Upstream = Schema.Struct({
  plan_type: Schema.optional(Schema.Unknown),
  rate_limit: Schema.Struct({
    allowed: Schema.Boolean,
    limit_reached: Schema.Boolean,
    primary_window: Schema.optional(Schema.Unknown),
    secondary_window: Schema.optional(Schema.Unknown),
  }),
})
const Window = Schema.Struct({
  used_percent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  limit_window_seconds: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(31536000),
  ),
  reset_at: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 8640000000000 }))),
  ),
  reset_after_seconds: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 31536000 }))),
  ),
})

/** The upstream endpoint is undocumented. Unknown fields never cross the API boundary. */
export function parseCodexUsage(input: unknown, now: number): Info | undefined {
  const decoded = Schema.decodeUnknownOption(Upstream)(input)
  if (Option.isNone(decoded)) return
  const data = decoded.value
  return {
    status: "fresh",
    updatedAt: now,
    ...(typeof data.plan_type === "string" && /^[a-z0-9_-]{1,40}$/.test(data.plan_type)
      ? { planType: data.plan_type }
      : {}),
    allowed: data.rate_limit.allowed,
    limitReached: data.rate_limit.limit_reached,
    windows: (["primary", "secondary"] as const).flatMap((kind) => {
      const result = Schema.decodeUnknownOption(Window)(data.rate_limit[`${kind}_window`])
      if (Option.isNone(result)) return []
      const window = result.value
      return [
        {
          kind,
          remainingPercent: 100 - window.used_percent,
          windowSeconds: window.limit_window_seconds,
          ...(window.reset_at != null
            ? { resetAt: window.reset_at * 1000 }
            : window.reset_after_seconds != null
              ? { resetAt: now + window.reset_after_seconds * 1000 }
              : {}),
        },
      ]
    }),
  }
}

export interface Account {
  readonly key: string
  readonly access: string
  readonly accountID?: string
}

interface CacheEntry {
  retryAt: number
  accessedAt: number
  data?: Info
}

export interface Cache {
  readonly entries: Map<string, CacheEntry>
  readonly locks: KeyedMutex.KeyedMutex<string>
  readonly guard: Semaphore.Semaphore
  readonly maximum: number
}

export function makeCache(maximum = 8): Cache {
  return { entries: new Map(), locks: KeyedMutex.makeUnsafe(), guard: Semaphore.makeUnsafe(1), maximum }
}

function identity(account: Account | undefined) {
  return account ? `${account.key}\0${account.accountID ?? ""}` : undefined
}

/** Uses a caller-owned bounded cache; entries contain sanitized usage only. */
export function createCodexUsage(input: {
  current: Effect.Effect<Account | undefined>
  resolve: (account: Account) => Effect.Effect<Account | undefined, unknown>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  cache?: Cache
}) {
  const cache = input.cache ?? makeCache()
  const empty = (status: "unknown" | "unsupported"): Info => ({ status, windows: [] })
  return () =>
    Effect.gen(function* () {
      const discovered = yield* input.current
      if (!discovered) return empty("unsupported")
      if (!discovered.accountID) return empty("unknown")
      const key = `${discovered.key}\0${discovered.accountID}`
      return yield* cache.locks.withLock(key)(
        Effect.gen(function* () {
          const current = yield* input.current
          if (identity(current) !== key || !current?.accountID) return empty("unknown")
          const now = yield* Clock.currentTimeMillis
          const cached = yield* cache.guard.withPermit(
            Effect.sync(() => {
              const entry = cache.entries.get(key) ?? { retryAt: 0, accessedAt: now }
              entry.accessedAt = now
              if (cache.entries.has(key)) return entry
              if (cache.entries.size >= cache.maximum) {
                const oldest = Array.from(cache.entries).toSorted((a, b) => a[1].accessedAt - b[1].accessedAt)[0]
                if (oldest) cache.entries.delete(oldest[0])
              }
              cache.entries.set(key, entry)
              return entry
            }),
          )
          const previous =
            cached.data?.updatedAt != null && now - cached.data.updatedAt < 15 * 60000 ? cached.data : undefined
          if (now < cached.retryAt) return previous ?? empty("unknown")
          const result = yield* Effect.gen(function* () {
            const value = yield* input.resolve(current)
            if (!value?.accountID || value.key !== current.key || value.accountID !== current.accountID)
              return undefined
            const accountID = value.accountID
            return yield* Effect.tryPromise({
              try: async (signal) => {
                const response = await (input.fetch ?? fetch)("https://chatgpt.com/backend-api/wham/usage", {
                  method: "GET",
                  redirect: "error",
                  headers: {
                    Authorization: `Bearer ${value.access}`,
                    "ChatGPT-Account-Id": accountID,
                    Accept: "application/json",
                  },
                  signal,
                })
                if (!response.ok) return undefined
                return parseCodexUsage(await response.json(), now)
              },
              catch: () => undefined,
            })
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          // Logout/reconnection can happen while OAuth refresh or the upstream request is pending.
          const latest = yield* input.current
          if (identity(latest) !== key) {
            yield* cache.guard.withPermit(Effect.sync(() => cache.entries.delete(key)))
            return empty("unknown")
          }
          cached.retryAt = now + 60000
          cached.data = result ?? (previous ? { ...previous, status: "stale" } : undefined)
          return cached.data ?? empty("unknown")
        }),
      )
    })
}

export interface Interface {
  readonly read: () => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodexUsage") {}

const supported = (credential: Credential.Info | undefined): Account | undefined => {
  if (credential?.value.type !== "oauth") return
  if (credential.value.methodID !== "chatgpt-browser" && credential.value.methodID !== "chatgpt-headless") return
  const accountID = credential.value.metadata?.accountID
  return {
    key: credential.id,
    access: credential.value.access,
    ...(typeof accountID === "string" && /^[\x21-\x7e]{1,256}$/.test(accountID) ? { accountID } : {}),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    return Service.of({
      read: createCodexUsage({
        cache,
        current: credentials.list(Integration.ID.make("openai")).pipe(Effect.map((items) => supported(items.at(-1)))),
        resolve: (account) =>
          integrations.connection.resolve({ type: "credential", id: Credential.ID.make(account.key), label: "" }).pipe(
            Effect.map((value) =>
              value?.type === "oauth"
                ? supported(
                    new Credential.Info({
                      id: Credential.ID.make(account.key),
                      integrationID: Integration.ID.make("openai"),
                      label: "",
                      value,
                    }),
                  )
                : undefined,
            ),
          ),
      }),
    })
  }),
)

const cache = makeCache()

export const node = makeLocationNode({ service: Service, layer, deps: [Credential.node, Integration.node] })
