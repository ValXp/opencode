import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("conditionally updates only the OAuth revision it read", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const provider = "test-oauth-revision"
      const old = new Auth.Oauth({ type: "oauth", access: "old", refresh: "refresh-old", expires: 1 })
      const next = new Auth.Oauth({ type: "oauth", access: "new", refresh: "refresh-new", expires: 2 })
      yield* auth.set(provider, old)
      const initialGeneration = (yield* auth.connection(provider)).generation
      expect(yield* auth.updateOauth(provider, "other-refresh", next)).toBe(false)
      expect(yield* auth.get(provider)).toEqual(old)
      expect(yield* auth.updateOauth(provider, "refresh-old", next)).toBe(true)
      expect(yield* auth.get(provider)).toEqual(next)
      expect((yield* auth.connection(provider)).generation).toBe(initialGeneration)
      yield* auth.remove(provider)
      expect((yield* auth.connection(provider)).generation).not.toBe(initialGeneration)
      expect(yield* auth.updateOauth(provider, "refresh-new", old)).toBe(false)
      expect(yield* auth.get(provider)).toBeUndefined()
    }),
  )

  it.instance("rejects an expired OAuth refresh commit while holding the mutation lock", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const current = new Auth.Oauth({ type: "oauth", access: "old", refresh: "refresh-old", expires: 1 })
      const late = new Auth.Oauth({ type: "oauth", access: "late", refresh: "refresh-late", expires: 2 })
      yield* auth.set("test-oauth-deadline", current)
      expect(yield* auth.updateOauth("test-oauth-deadline", current.refresh, late, { deadline: Date.now() - 1 })).toBe(
        false,
      )
      expect(yield* auth.get("test-oauth-deadline")).toEqual(current)
    }),
  )

  it.instance("serializes conditional refresh commits with replacement and logout", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const provider = "test-oauth-race"
      const old = new Auth.Oauth({ type: "oauth", access: "old", refresh: "refresh-old", expires: 1 })
      const refreshed = new Auth.Oauth({ type: "oauth", access: "new", refresh: "refresh-new", expires: 2 })
      const replacement = new Auth.Oauth({ type: "oauth", access: "other", refresh: "refresh-other", expires: 3 })

      yield* auth.set(provider, old)
      yield* Effect.all([auth.updateOauth(provider, old.refresh, refreshed), auth.set(provider, replacement)], {
        concurrency: "unbounded",
      })
      expect(yield* auth.get(provider)).toEqual(replacement)

      yield* auth.set(provider, old)
      yield* Effect.all([auth.updateOauth(provider, old.refresh, refreshed), auth.remove(provider)], {
        concurrency: "unbounded",
      })
      expect(yield* auth.get(provider)).toBeUndefined()
    }),
  )

  it.instance("advances the connection when a refresh resolves to another explicit account", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const provider = "test-oauth-account"
      const old = new Auth.Oauth({
        type: "oauth",
        access: "old",
        refresh: "refresh-old",
        expires: 1,
        accountId: "account-a",
      })
      yield* auth.set(provider, old)
      const generation = (yield* auth.connection(provider)).generation
      yield* auth.updateOauth(
        provider,
        old.refresh,
        new Auth.Oauth({
          type: "oauth",
          access: "new",
          refresh: "refresh-new",
          expires: 2,
          accountId: "account-b",
        }),
      )
      expect((yield* auth.connection(provider)).generation).not.toBe(generation)
      yield* auth.remove(provider)
    }),
  )
})
