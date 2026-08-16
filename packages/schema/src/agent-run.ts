export * as AgentRun from "./agent-run"

import { Schema } from "effect"
import { Agent } from "./agent"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { Model } from "./model"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { Session } from "./session"
import { SessionMessage } from "./session-message"

export const ID = Schema.String.check(Schema.isStartsWith("arun_")).pipe(
  Schema.brand("AgentRun.ID"),
  statics((schema) => ({ create: () => schema.make("arun_" + ascending()) })),
)
export type ID = typeof ID.Type

export const State = Schema.Union([
  Schema.Struct({ type: Schema.Literal("running") }),
  Schema.Struct({
    type: Schema.Literal("retrying"),
    attempt: NonNegativeInt,
    message: Schema.String,
    next: DateTimeUtcFromMillis,
  }),
  Schema.Struct({ type: Schema.Literal("succeeded") }),
  Schema.Struct({ type: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cancelled") }),
  Schema.Struct({ type: Schema.Literal("interrupted"), reason: Schema.String.pipe(optional) }),
  Schema.Struct({
    type: Schema.Literal("unknown"),
    reason: Schema.Literals(["owner_lost", "legacy_ambiguous", "orphaned"]),
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "AgentRun.State" })
export type State = typeof State.Type

export interface Node extends Schema.Schema.Type<typeof Node> {}
export const Node = Schema.Struct({
  sessionID: Session.ID,
  parentSessionID: Session.ID,
  title: Schema.String,
  agent: Agent.ID.pipe(optional),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRun.Node" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  sessionID: Session.ID,
  callerSessionID: Session.ID,
  previousRunID: ID.pipe(optional),
  source: Schema.Struct({
    messageID: SessionMessage.ID,
    callID: Schema.String,
  }),
  agent: Agent.ID,
  description: Schema.String,
  model: Model.Ref.pipe(optional),
  background: Schema.Boolean,
  state: State,
  activity: Schema.Struct({
    at: DateTimeUtcFromMillis,
    summary: Schema.String.pipe(optional),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    updated: DateTimeUtcFromMillis,
    finished: DateTimeUtcFromMillis.pipe(optional),
  }),
  version: NonNegativeInt,
}).annotate({ identifier: "AgentRun.Info" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  rootSessionID: Session.ID,
  nodes: Schema.Array(Node),
  active: Schema.Array(Info),
  history: Schema.Array(Info),
}).annotate({ identifier: "AgentRun.Snapshot" })

const Updated = define({
  type: "agent.run.updated",
  schema: { info: Info },
})
export const Event = { Updated, Definitions: inventory(Updated) }
