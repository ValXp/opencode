export * as AgentRun from "./agent-run"

import { AgentRun } from "@opencode-ai/schema/agent-run"
import { Agent } from "@opencode-ai/schema/agent"
import { Session } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { Cause, Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { AgentRunTable } from "./agent-run/sql"

const SNAPSHOT_HISTORY_LIMIT = 100

export const ID = AgentRun.ID
export type ID = AgentRun.ID

export const State = AgentRun.State
export type State = AgentRun.State

export const Node = AgentRun.Node
export type Node = AgentRun.Node

export const Info = AgentRun.Info
export type Info = AgentRun.Info

export const Snapshot = AgentRun.Snapshot
export type Snapshot = AgentRun.Snapshot

export const Overview = AgentRun.Overview
export type Overview = AgentRun.Overview

export const Event = AgentRun.Event

export interface AdmitInput {
  readonly sessionID: Info["sessionID"]
  readonly callerSessionID: Info["callerSessionID"]
  readonly source: Info["source"]
  readonly agent: Info["agent"]
  readonly description: string
  readonly model?: Info["model"]
  readonly background: boolean
  readonly ownerID: string
}

export interface Admission {
  readonly info: Info
  readonly created: boolean
}

export interface FindBySourceInput {
  readonly callerSessionID: Info["callerSessionID"]
  readonly source: Info["source"]
}

export interface TransitionInput {
  readonly id: ID
  readonly ownerID: string
  readonly state: State
}

export interface StartInput {
  readonly id: ID
  readonly ownerID: string
}

export interface TouchInput {
  readonly id: ID
  readonly ownerID: string
}

export interface ActivityCapture {
  readonly info: Info
  readonly revision: number
}

export interface SummarizeInput {
  readonly id: ID
  readonly ownerID: string
  readonly revision: number
  readonly summary: string
}

type SessionNodeRow = {
  session_id: string
  parent_session_id: string
  title: string
  agent: string | null
  created_at: number
}

export interface Interface {
  readonly admit: (input: AdmitInput) => Effect.Effect<Admission>
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly findBySource: (input: FindBySourceInput) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info | undefined>
  readonly transition: (input: TransitionInput) => Effect.Effect<Info | undefined>
  readonly touch: (input: TouchInput) => Effect.Effect<ActivityCapture | undefined>
  readonly summarize: (input: SummarizeInput) => Effect.Effect<Info | undefined>
  readonly snapshot: (rootSessionID: Info["sessionID"]) => Effect.Effect<Snapshot>
  readonly overview: () => Effect.Effect<Overview>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentRun") {}

const decodeState = Schema.decodeUnknownSync(State)

export interface LayerOptions {
  readonly afterActiveRead?: Effect.Effect<void>
}

function fromRow(row: typeof AgentRunTable.$inferSelect) {
  const state = decodeState(
    row.state_type === "retrying"
      ? {
          type: row.state_type,
          attempt: row.state_attempt,
          message: row.state_message,
          next: row.state_next,
        }
      : row.state_type === "failed"
        ? { type: row.state_type, error: row.state_error }
        : row.state_type === "interrupted"
          ? { type: row.state_type, reason: row.state_reason ?? undefined }
          : row.state_type === "unknown"
            ? { type: row.state_type, reason: row.state_reason }
            : { type: row.state_type },
  )
  return Info.make({
    id: row.id,
    sessionID: row.session_id,
    callerSessionID: row.caller_session_id,
    previousRunID: row.previous_run_id ?? undefined,
    source: { messageID: row.source_message_id, callID: row.source_call_id },
    agent: row.agent,
    description: row.description,
    model:
      row.model_id && row.model_provider_id
        ? {
            id: row.model_id,
            providerID: row.model_provider_id,
            variant: row.model_variant ?? undefined,
          }
        : undefined,
    background: row.background,
    state,
    activity: {
      at: DateTime.makeUnsafe(row.activity_at),
      summary: row.summary_revision === row.activity_revision ? (row.activity_summary ?? undefined) : undefined,
    },
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      started: row.time_started === null ? undefined : DateTime.makeUnsafe(row.time_started),
      updated: DateTime.makeUnsafe(row.time_updated),
      finished: row.time_finished === null ? undefined : DateTime.makeUnsafe(row.time_finished),
    },
    version: row.version,
  })
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const publishUpdate = Effect.fn("AgentRun.publishUpdate")((info: Info) =>
        events.publish(Event.Updated, { info }).pipe(
          Effect.asVoid,
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logWarning("failed to publish agent run update", { runID: info.id, cause }),
          ),
        ),
      )
      const bySource = (input: FindBySourceInput) =>
        and(
          eq(AgentRunTable.caller_session_id, input.callerSessionID),
          eq(AgentRunTable.source_message_id, input.source.messageID),
          eq(AgentRunTable.source_call_id, input.source.callID),
        )

      const get = Effect.fn("AgentRun.get")(function* (id: ID) {
        const row = yield* db.select().from(AgentRunTable).where(eq(AgentRunTable.id, id)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      })

      const findBySource = Effect.fn("AgentRun.findBySource")(function* (input: FindBySourceInput) {
        const row = yield* db.select().from(AgentRunTable).where(bySource(input)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      })

      const start = Effect.fn("AgentRun.start")(function* (input: StartInput) {
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .update(AgentRunTable)
          .set({
            time_started: now,
            time_updated: now,
            version: sql`${AgentRunTable.version} + 1`,
          })
          .where(
            and(
              eq(AgentRunTable.id, input.id),
              eq(AgentRunTable.owner_id, input.ownerID),
              inArray(AgentRunTable.state_type, ["running", "retrying"]),
              isNull(AgentRunTable.time_started),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row) {
          const info = fromRow(row)
          yield* publishUpdate(info)
          return info
        }
        const existing = yield* db
          .select()
          .from(AgentRunTable)
          .where(
            and(
              eq(AgentRunTable.id, input.id),
              eq(AgentRunTable.owner_id, input.ownerID),
              inArray(AgentRunTable.state_type, ["running", "retrying"]),
              isNotNull(AgentRunTable.time_started),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return existing ? fromRow(existing) : undefined
      })

      const transition = Effect.fn("AgentRun.transition")(function* (input: TransitionInput) {
        const now = yield* Clock.currentTimeMillis
        const active = input.state.type === "running" || input.state.type === "retrying"
        const row = yield* db
          .update(AgentRunTable)
          .set({
            state_type: input.state.type,
            state_attempt: input.state.type === "retrying" ? input.state.attempt : null,
            state_message: input.state.type === "retrying" ? input.state.message : null,
            state_next: input.state.type === "retrying" ? DateTime.toEpochMillis(input.state.next) : null,
            state_error: input.state.type === "failed" ? input.state.error : null,
            state_reason:
              input.state.type === "interrupted" || input.state.type === "unknown"
                ? (input.state.reason ?? null)
                : null,
            owner_id: active ? input.ownerID : null,
            time_updated: now,
            time_finished: active ? null : now,
            version: sql`${AgentRunTable.version} + 1`,
          })
          .where(
            and(
              eq(AgentRunTable.id, input.id),
              eq(AgentRunTable.owner_id, input.ownerID),
              inArray(AgentRunTable.state_type, ["running", "retrying"]),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        const info = fromRow(row)
        yield* publishUpdate(info)
        return info
      })

      const touch = Effect.fn("AgentRun.touch")(function* (input: TouchInput) {
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .update(AgentRunTable)
          .set({
            activity_at: now,
            activity_revision: sql`${AgentRunTable.activity_revision} + 1`,
            time_updated: now,
            version: sql`${AgentRunTable.version} + 1`,
          })
          .where(
            and(
              eq(AgentRunTable.id, input.id),
              eq(AgentRunTable.owner_id, input.ownerID),
              inArray(AgentRunTable.state_type, ["running", "retrying"]),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        const info = fromRow(row)
        yield* publishUpdate(info)
        return { info, revision: row.activity_revision }
      })

      const summarize = Effect.fn("AgentRun.summarize")(function* (input: SummarizeInput) {
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .update(AgentRunTable)
          .set({
            activity_summary: input.summary,
            summary_revision: input.revision,
            time_updated: now,
            version: sql`${AgentRunTable.version} + 1`,
          })
          .where(
            and(
              eq(AgentRunTable.id, input.id),
              eq(AgentRunTable.owner_id, input.ownerID),
              inArray(AgentRunTable.state_type, ["running", "retrying"]),
              eq(AgentRunTable.activity_revision, input.revision),
              or(isNull(AgentRunTable.summary_revision), lt(AgentRunTable.summary_revision, input.revision)),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        const info = fromRow(row)
        yield* publishUpdate(info)
        return info
      })

      const snapshot = Effect.fn("AgentRun.snapshot")(function* (rootSessionID: Info["sessionID"]) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Session parent links are not constrained against cycles, so carry visited IDs through the recursion.
              const rows = yield* tx.all<SessionNodeRow>(sql`
              WITH RECURSIVE family(session_id, parent_session_id, title, agent, created_at, depth, path) AS (
                SELECT id, parent_id, title, agent, time_created, 0, ',' || id || ','
                FROM session
                WHERE id = ${rootSessionID}
                UNION ALL
                SELECT
                  child.id,
                  child.parent_id,
                  child.title,
                  child.agent,
                  child.time_created,
                  parent.depth + 1,
                  parent.path || child.id || ','
                FROM session AS child
                INNER JOIN family AS parent ON child.parent_id = parent.session_id
                WHERE instr(parent.path, ',' || child.id || ',') = 0
              )
              SELECT session_id, parent_session_id, title, agent, created_at
              FROM family
              WHERE depth > 0
              ORDER BY depth, created_at, session_id
            `)
              const nodes = rows.map((row) =>
                Node.make({
                  sessionID: Session.ID.make(row.session_id),
                  parentSessionID: Session.ID.make(row.parent_session_id),
                  title: row.title,
                  agent: row.agent ? Agent.ID.make(row.agent) : undefined,
                  createdAt: DateTime.makeUnsafe(row.created_at),
                }),
              )
              const family = [rootSessionID, ...nodes.map((node) => node.sessionID)]
              const active = (yield* tx
                .select()
                .from(AgentRunTable)
                .where(
                  and(
                    inArray(AgentRunTable.session_id, family),
                    inArray(AgentRunTable.state_type, ["running", "retrying"]),
                  ),
                )
                .orderBy(asc(AgentRunTable.time_created), asc(AgentRunTable.id))
                .all()).map(fromRow)
              if (options.afterActiveRead) yield* options.afterActiveRead
              const history = (yield* tx
                .select()
                .from(AgentRunTable)
                .where(and(inArray(AgentRunTable.session_id, family), isNotNull(AgentRunTable.time_finished)))
                .orderBy(desc(AgentRunTable.time_finished), desc(AgentRunTable.id))
                .limit(SNAPSHOT_HISTORY_LIMIT)
                .all()).map(fromRow)
              return Snapshot.make({
                rootSessionID,
                nodes: snapshotNodes(rootSessionID, nodes, active.concat(history)),
                active,
                history,
              })
            }),
          )
          .pipe(Effect.orDie)
      })

      const overview = Effect.fn("AgentRun.overview")(function* () {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const active = (yield* tx
                .select()
                .from(AgentRunTable)
                .where(inArray(AgentRunTable.state_type, ["running", "retrying"]))
                .orderBy(asc(AgentRunTable.time_created), asc(AgentRunTable.id))
                .all()).map(fromRow)
              if (options.afterActiveRead) yield* options.afterActiveRead
              const latestHistory = (yield* tx
                .select()
                .from(AgentRunTable)
                .where(isNotNull(AgentRunTable.time_finished))
                .orderBy(desc(AgentRunTable.time_finished), desc(AgentRunTable.id))
                .limit(SNAPSHOT_HISTORY_LIMIT)
                .all()).map(fromRow)
              const successors = (yield* tx
                .select()
                .from(AgentRunTable)
                .where(
                  and(
                    isNotNull(AgentRunTable.time_finished),
                    sql`EXISTS (
                      SELECT 1
                      FROM agent_run AS active
                      WHERE active.session_id = ${AgentRunTable.session_id}
                        AND active.state_type IN ('running', 'retrying')
                        AND (
                          active.time_created < ${AgentRunTable.time_created}
                          OR (
                            active.time_created = ${AgentRunTable.time_created}
                            AND active.id < ${AgentRunTable.id}
                          )
                        )
                    )`,
                    sql`NOT EXISTS (
                      SELECT 1
                      FROM agent_run AS newer
                      WHERE newer.session_id = ${AgentRunTable.session_id}
                        AND newer.time_finished IS NOT NULL
                        AND (
                          newer.time_created > ${AgentRunTable.time_created}
                          OR (
                            newer.time_created = ${AgentRunTable.time_created}
                            AND newer.id > ${AgentRunTable.id}
                          )
                        )
                    )`,
                  ),
                )
                .orderBy(desc(AgentRunTable.time_finished), desc(AgentRunTable.id))
                .all()).map(fromRow)
              const latestHistoryIDs = new Set(latestHistory.map((run) => run.id))
              const history = latestHistory.concat(successors.filter((run) => !latestHistoryIDs.has(run.id)))
              const sessionIDs = Array.from(new Set(active.concat(history).map((run) => run.sessionID)))
              if (sessionIDs.length === 0) return Overview.make({ nodes: [], active, history })

              const rows = yield* tx.all<SessionNodeRow>(sql`
                WITH RECURSIVE ancestors(session_id, parent_session_id, title, agent, created_at) AS (
                  SELECT id, parent_id, title, agent, time_created
                  FROM session
                  WHERE id IN (${sql.join(
                    sessionIDs.map((sessionID) => sql`${sessionID}`),
                    sql`, `,
                  )})
                  UNION
                  SELECT
                    parent.id,
                    parent.parent_id,
                    parent.title,
                    parent.agent,
                    parent.time_created
                  FROM session AS parent
                  INNER JOIN ancestors AS child ON parent.id = child.parent_session_id
                )
                SELECT session_id, parent_session_id, title, agent, created_at
                FROM ancestors
                WHERE parent_session_id IS NOT NULL
                ORDER BY created_at, session_id
              `)
              return Overview.make({
                nodes: rows.map((row) =>
                  Node.make({
                    sessionID: Session.ID.make(row.session_id),
                    parentSessionID: Session.ID.make(row.parent_session_id),
                    title: row.title,
                    agent: row.agent ? Agent.ID.make(row.agent) : undefined,
                    createdAt: DateTime.makeUnsafe(row.created_at),
                  }),
                ),
                active,
                history,
              })
            }),
          )
          .pipe(Effect.orDie)
      })

      const admit = Effect.fn("AgentRun.admit")(function* (input: AdmitInput) {
        const now = yield* Clock.currentTimeMillis
        const admitted = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const source = bySource(input)
              const existing = yield* tx.select().from(AgentRunTable).where(source).get()
              if (existing) return { info: fromRow(existing), created: false }

              const previous = yield* tx
                .select({ id: AgentRunTable.id })
                .from(AgentRunTable)
                .where(eq(AgentRunTable.session_id, input.sessionID))
                .orderBy(desc(AgentRunTable.time_created), desc(AgentRunTable.id))
                .limit(1)
                .get()
              const inserted = yield* tx
                .insert(AgentRunTable)
                .values({
                  id: ID.create(),
                  session_id: input.sessionID,
                  caller_session_id: input.callerSessionID,
                  previous_run_id: previous?.id,
                  source_message_id: input.source.messageID,
                  source_call_id: input.source.callID,
                  agent: input.agent,
                  description: input.description,
                  model_provider_id: input.model?.providerID,
                  model_id: input.model?.id,
                  model_variant: input.model?.variant,
                  background: input.background,
                  state_type: "running",
                  owner_id: input.ownerID,
                  activity_at: now,
                  time_created: now,
                  time_updated: now,
                })
                .onConflictDoNothing()
                .returning()
                .get()
              if (inserted) return { info: fromRow(inserted), created: true }

              const replayed = yield* tx.select().from(AgentRunTable).where(source).get()
              if (replayed) return { info: fromRow(replayed), created: false }
              return yield* Effect.die(new Error("AgentRun admission conflicted without a matching source"))
            }),
          )
          .pipe(Effect.orDie)
        if (admitted.created) yield* publishUpdate(admitted.info)
        return admitted
      })

      return Service.of({ admit, get, findBySource, start, transition, touch, summarize, snapshot, overview })
    }),
  )

export const node = makeGlobalNode({ service: Service, layer: layerWith(), deps: [Database.node, EventV2.node] })

function snapshotNodes(rootSessionID: Info["sessionID"], nodes: Node[], runs: Info[]) {
  const bySessionID = new Map(nodes.map((node) => [node.sessionID, node]))
  const included = new Set<Info["sessionID"]>()
  const includeAncestors = (sessionID: Info["sessionID"], seen: Set<Info["sessionID"]>) => {
    if (sessionID === rootSessionID || seen.has(sessionID)) return
    const node = bySessionID.get(sessionID)
    if (!node) return
    included.add(sessionID)
    seen.add(sessionID)
    includeAncestors(node.parentSessionID, seen)
  }
  runs.forEach((run) => includeAncestors(run.sessionID, new Set()))
  return nodes.filter((node) => included.has(node.sessionID))
}
