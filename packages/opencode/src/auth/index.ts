import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context, Semaphore } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AuthConnection } from "./connection"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly updateOauth: (
    key: string,
    expectedRefresh: string,
    info: Oauth,
    options?: { readonly deadline?: number },
  ) => Effect.Effect<boolean, AuthError>
  readonly connection: (key: string) => Effect.Effect<{ info: Info | undefined; generation: string }, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

// Auth.Service can be instantiated by both global and Location graphs; file mutations must share one process lock.
const lock = Semaphore.makeUnsafe(1)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const read = Effect.fnUntraced(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const write = (data: Record<string, Info>) =>
      fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))

    const all = Effect.fn("Auth.all")(() => lock.withPermit(read()))

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const connection = Effect.fn("Auth.connection")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const data = yield* read()
          return { info: data[norm] ?? data[key], generation: AuthConnection.current(norm) }
        }),
      )
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      yield* lock.withPermit(
        Effect.gen(function* () {
          const data = yield* read()
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* write({ ...data, [norm]: info })
          AuthConnection.advance(norm)
        }),
      )
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      yield* lock.withPermit(
        Effect.gen(function* () {
          const data = yield* read()
          delete data[key]
          delete data[norm]
          yield* write(data)
          AuthConnection.advance(norm)
        }),
      )
    })

    const updateOauth = Effect.fn("Auth.updateOauth")(function* (
      key: string,
      expectedRefresh: string,
      info: Oauth,
      options?: { readonly deadline?: number },
    ) {
      const norm = key.replace(/\/+$/, "")
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const data = yield* read()
          const current = data[norm] ?? data[key]
          if (current?.type !== "oauth" || current.refresh !== expectedRefresh) return false
          if (options?.deadline !== undefined && Date.now() >= options.deadline) return false
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* write({ ...data, [norm]: info })
          if (current.accountId && info.accountId && current.accountId !== info.accountId) AuthConnection.advance(norm)
          return true
        }),
      )
    })

    return Service.of({ get, all, set, remove, updateOauth, connection })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
