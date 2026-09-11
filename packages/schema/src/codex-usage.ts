export * as CodexUsage from "./codex-usage"

import { Schema } from "effect"
import { optional } from "./schema"

export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  kind: Schema.Literals(["primary", "secondary"]),
  remainingPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  windowSeconds: Schema.Finite.check(Schema.isGreaterThan(0)),
  /** Unix time in milliseconds. */
  resetAt: optional(Schema.Finite),
}).annotate({ identifier: "CodexUsage.Window" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  status: Schema.Literals(["unsupported", "unknown", "fresh", "stale"]),
  /** Last successful observation, Unix time in milliseconds. */
  updatedAt: optional(Schema.Finite),
  planType: optional(Schema.String),
  allowed: optional(Schema.Boolean),
  limitReached: optional(Schema.Boolean),
  windows: Schema.Array(Window),
}).annotate({ identifier: "CodexUsage.Info" })
