import { Effect, Layer } from "effect"
import { CodexUsage } from "@opencode-ai/core/codex-usage"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Auth } from "@/auth"
import { AuthConnection } from "@/auth/connection"
import { extractAccountIdFromClaims, parseJwtClaims, resolveCodexOAuth } from "./codex"

const cache = CodexUsage.makeCache()
AuthConnection.listen("openai", () => cache.entries.clear())

function accountID(value: Auth.Oauth) {
  const claims = value.accountId ? undefined : parseJwtClaims(value.access)
  const id = value.accountId ?? (claims ? extractAccountIdFromClaims(claims) : undefined)
  return typeof id === "string" && /^[\x21-\x7e]{1,256}$/.test(id) ? id : undefined
}

export function makeLayer(options?: {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  now?: () => number
  cache?: CodexUsage.Cache
  refreshTimeoutMs?: number
}) {
  return Layer.effect(
    CodexUsage.Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const current = Effect.gen(function* () {
        const connection = yield* auth.connection("openai").pipe(Effect.orElseSucceed(() => undefined))
        const value = connection?.info
        if (!connection || value?.type !== "oauth") return
        return { key: connection.generation, access: value.access, accountID: accountID(value) }
      })
      return CodexUsage.Service.of({
        read: CodexUsage.createCodexUsage({
          cache: options?.cache ?? cache,
          current,
          resolve: (account) =>
            Effect.tryPromise({
              try: async (signal) => {
                const value = await resolveCodexOAuth({
                  get: () =>
                    Effect.runPromise(
                      auth.get("openai").pipe(
                        Effect.map((item) => (item?.type === "oauth" ? item : undefined)),
                        Effect.orElseSucceed(() => undefined),
                      ),
                    ),
                  set: (expectedRefresh, item, commit) =>
                    Effect.runPromise(
                      auth.updateOauth("openai", expectedRefresh, new Auth.Oauth({ type: "oauth", ...item }), {
                        deadline: commit.deadline,
                      }),
                      { signal: commit.signal },
                    ),
                  fetch: options?.fetch,
                  now: options?.now,
                  signal,
                  refreshTimeoutMs: options?.refreshTimeoutMs,
                })
                if (!value) return
                const nextAccountID = value.accountId ?? accountID(new Auth.Oauth({ type: "oauth", ...value }))
                if (nextAccountID !== account.accountID) return
                return { key: account.key, access: value.access, accountID: nextAccountID }
              },
              catch: (cause) => cause,
            }),
          fetch: options?.fetch,
        }),
      })
    }),
  )
}

export const node = makeLocationNode({ service: CodexUsage.Service, layer: makeLayer(), deps: [Auth.node] })

export * as LegacyCodexUsage from "./codex-usage"
