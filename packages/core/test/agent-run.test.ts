import { describe, expect } from "bun:test"
import { AgentRun } from "@opencode-ai/core/agent-run"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Context, DateTime, Deferred, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"
import { it as effectIt, testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, EventV2.node, AgentRun.node])))
const rootSessionID = SessionV2.ID.make("ses_agent_run_root")
const childSessionID = SessionV2.ID.make("ses_agent_run_child")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: rootSessionID,
        project_id: ProjectV2.ID.global,
        slug: "root",
        directory: "/project",
        title: "Root",
        version: "test",
        time_created: 1,
        time_updated: 1,
      },
      {
        id: childSessionID,
        project_id: ProjectV2.ID.global,
        parent_id: rootSessionID,
        slug: "child",
        directory: "/project",
        title: "Child",
        version: "test",
        agent: "review",
        time_created: 2,
        time_updated: 2,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const admitInfo = (runs: AgentRun.Interface, input: AgentRun.AdmitInput) =>
  runs.admit(input).pipe(Effect.map((result) => result.info))

describe("AgentRun", () => {
  it.effect("reports whether a durable unstarted admission was newly created", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const input = {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_source"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Review the persistence slice",
        model: ModelV2.Ref.make({
          id: ModelV2.ID.make("gpt-5.6"),
          providerID: ProviderV2.ID.make("openai"),
          variant: ModelV2.VariantID.make("high"),
        }),
        background: true,
        ownerID: "process-1",
      }

      const admitted = yield* runs.admit(input)
      const replayed = yield* runs.admit(input)

      expect(admitted.created).toBe(true)
      expect(replayed.created).toBe(false)
      expect(replayed.info).toEqual(admitted.info)
      expect(yield* runs.get(admitted.info.id)).toEqual(admitted.info)
      expect(admitted.info).toMatchObject({
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: input.source,
        agent: input.agent,
        description: input.description,
        model: input.model,
        background: true,
        state: { type: "running" },
        version: 0,
      })
      expect(admitted.info.previousRunID).toBeUndefined()
      expect(admitted.info.activity.summary).toBeUndefined()
      expect(DateTime.toEpochMillis(admitted.info.activity.at)).toBe(0)
      expect(DateTime.toEpochMillis(admitted.info.time.created)).toBe(0)
      expect(admitted.info.time.started).toBeUndefined()
      expect(DateTime.toEpochMillis(admitted.info.time.updated)).toBe(0)
      expect(admitted.info.time.finished).toBeUndefined()
    }),
  )

  it.effect("keeps a durable admission when advisory event delivery fails", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen(() => Effect.die(new Error("event delivery failed")))
      yield* Effect.addFinalizer(() => unsubscribe)

      const admitted = yield* runs.admit({
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_event_failure"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Survive advisory event failure",
        background: true,
        ownerID: "process-1",
      })

      expect(admitted.created).toBe(true)
      expect(yield* runs.get(admitted.info.id)).toEqual(admitted.info)
    }),
  )

  it.effect("finds a run only by its exact admission source", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const source = { messageID: SessionMessage.ID.make("msg_agent_run_find_source"), callID: "call_1" }

      expect(yield* runs.findBySource({ callerSessionID: rootSessionID, source })).toBeUndefined()
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source,
        agent: AgentV2.ID.make("review"),
        description: "Find the admitted run",
        background: true,
        ownerID: "process-1",
      })

      expect(yield* runs.findBySource({ callerSessionID: rootSessionID, source })).toEqual(admitted)
      expect(yield* runs.findBySource({ callerSessionID: childSessionID, source })).toBeUndefined()
      expect(
        yield* runs.findBySource({ callerSessionID: rootSessionID, source: { ...source, callID: "call_2" } }),
      ).toBeUndefined()
    }),
  )

  it.effect("starts an owned active run once and publishes only the first update", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_start"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Start after durable admission",
        background: true,
        ownerID: "process-1",
      })
      const events = yield* EventV2.Service
      const published = new Array<AgentRun.Info>()
      const isUpdated = Schema.is(AgentRun.Event.Updated.data)
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === AgentRun.Event.Updated.type && isUpdated(event.data)) published.push(event.data.info)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* TestClock.adjust(Duration.seconds(1))
      const started = yield* runs.start({ id: admitted.id, ownerID: "process-1" })
      yield* TestClock.adjust(Duration.seconds(1))
      const repeated = yield* runs.start({ id: admitted.id, ownerID: "process-1" })

      expect(started?.time.started?.pipe(DateTime.toEpochMillis)).toBe(1_000)
      expect(started?.time.updated.pipe(DateTime.toEpochMillis)).toBe(1_000)
      expect(started?.version).toBe(1)
      expect(repeated).toEqual(started)
      expect(yield* runs.get(admitted.id)).toEqual(started)
      expect(published).toEqual(started ? [started] : [])
    }),
  )

  it.effect("links a new admission for the same child to its previous run", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const first = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_first"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "First pass",
        background: false,
        ownerID: "process-1",
      })
      const resumed = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_resume"), callID: "call_2" },
        agent: AgentV2.ID.make("review"),
        description: "Resume the review",
        background: false,
        ownerID: "process-1",
      })

      expect(first.previousRunID).toBeUndefined()
      expect(resumed.previousRunID).toBe(first.id)
    }),
  )

  it.effect("moves an owned active run between retrying and running", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_transition"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Retry a review",
        background: true,
        ownerID: "process-1",
      })
      const retryingState = {
        type: "retrying" as const,
        attempt: 1,
        message: "Provider overloaded",
        next: DateTime.makeUnsafe(5_000),
      }

      const retrying = yield* runs.transition({ id: admitted.id, ownerID: "process-1", state: retryingState })
      const running = yield* runs.transition({ id: admitted.id, ownerID: "process-1", state: { type: "running" } })

      expect(retrying?.state).toEqual(retryingState)
      expect(retrying?.version).toBe(1)
      expect(running?.state).toEqual({ type: "running" })
      expect(running?.version).toBe(2)
      expect(running?.time.finished).toBeUndefined()
    }),
  )

  it.effect("compare-and-sets every terminal state once and never changes it again", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const terminalStates: AgentRun.State[] = [
        { type: "succeeded" },
        { type: "failed", error: "Review failed" },
        { type: "cancelled" },
        { type: "interrupted", reason: "Session interrupted" },
        { type: "unknown", reason: "owner_lost" },
      ]

      yield* Effect.forEach(terminalStates, (state, index) =>
        Effect.gen(function* () {
          const admitted = yield* admitInfo(runs, {
            sessionID: childSessionID,
            callerSessionID: rootSessionID,
            source: {
              messageID: SessionMessage.ID.make(`msg_agent_run_terminal_${index}`),
              callID: `call_${index}`,
            },
            agent: AgentV2.ID.make("review"),
            description: `Terminal state ${state.type}`,
            background: true,
            ownerID: "process-1",
          })

          const terminal = yield* runs.transition({ id: admitted.id, ownerID: "process-1", state })
          const stale = yield* runs.transition({
            id: admitted.id,
            ownerID: "process-1",
            state: { type: "running" },
          })

          expect(terminal?.state).toEqual(state)
          expect(terminal?.version).toBe(1)
          expect(terminal?.time.finished).toBeDefined()
          expect(stale).toBeUndefined()
          expect(yield* runs.get(admitted.id)).toEqual(terminal)
        }),
      )
    }),
  )

  it.effect("touches activity with a new revision, version, and timestamp", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_touch"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Track activity",
        background: true,
        ownerID: "process-1",
      })

      yield* TestClock.adjust(Duration.seconds(1))
      const first = yield* runs.touch({ id: admitted.id, ownerID: "process-1" })
      yield* TestClock.adjust(Duration.seconds(1))
      const second = yield* runs.touch({ id: admitted.id, ownerID: "process-1" })

      expect(first?.revision).toBe(1)
      expect(first?.info.version).toBe(1)
      expect(first?.info.activity.at.pipe(DateTime.toEpochMillis)).toBe(1_000)
      expect(first?.info.time.updated.pipe(DateTime.toEpochMillis)).toBe(1_000)
      expect(second?.revision).toBe(2)
      expect(second?.info.version).toBe(2)
      expect(second?.info.activity.at.pipe(DateTime.toEpochMillis)).toBe(2_000)
      expect(second?.info.activity.summary).toBeUndefined()
    }),
  )

  it.effect("stores a summary only for the captured current activity revision", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_summary"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Summarize activity",
        background: true,
        ownerID: "process-1",
      })
      yield* TestClock.adjust(Duration.seconds(1))
      const first = yield* runs.touch({ id: admitted.id, ownerID: "process-1" })
      yield* TestClock.adjust(Duration.seconds(1))
      const current = yield* runs.touch({ id: admitted.id, ownerID: "process-1" })

      const stale = yield* runs.summarize({
        id: admitted.id,
        ownerID: "process-1",
        revision: first?.revision ?? 0,
        summary: "Stale summary",
      })
      yield* TestClock.adjust(Duration.seconds(1))
      const summarized = yield* runs.summarize({
        id: admitted.id,
        ownerID: "process-1",
        revision: current?.revision ?? 0,
        summary: "Reviewed the persistence layer",
      })
      const duplicate = yield* runs.summarize({
        id: admitted.id,
        ownerID: "process-1",
        revision: current?.revision ?? 0,
        summary: "Duplicate summary",
      })

      expect(stale).toBeUndefined()
      expect(summarized?.activity.summary).toBe("Reviewed the persistence layer")
      expect(summarized?.activity.at.pipe(DateTime.toEpochMillis)).toBe(2_000)
      expect(summarized?.time.updated.pipe(DateTime.toEpochMillis)).toBe(3_000)
      expect(summarized?.version).toBe(3)
      expect(duplicate).toBeUndefined()
      expect(yield* runs.get(admitted.id)).toEqual(summarized)
    }),
  )

  it.effect("hides a stored summary after newer activity", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_stale_summary"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Invalidate a summary",
        background: true,
        ownerID: "process-1",
      })
      const captured = yield* runs.touch({ id: admitted.id, ownerID: "process-1" })
      const summarized = yield* runs.summarize({
        id: admitted.id,
        ownerID: "process-1",
        revision: captured?.revision ?? 0,
        summary: "Current summary",
      })

      const touched = yield* runs.touch({ id: admitted.id, ownerID: "process-1" })

      expect(summarized?.activity.summary).toBe("Current summary")
      expect(touched?.info.activity.summary).toBeUndefined()
      expect((yield* runs.get(admitted.id))?.activity.summary).toBeUndefined()
    }),
  )

  it.effect("rejects lifecycle writes from a foreign owner", () =>
    Effect.gen(function* () {
      yield* setup
      const runs = yield* AgentRun.Service
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_foreign_owner"), callID: "call_1" },
        agent: AgentV2.ID.make("review"),
        description: "Protect a live owner",
        background: true,
        ownerID: "process-live",
      })

      expect(yield* runs.start({ id: admitted.id, ownerID: "process-foreign" })).toBeUndefined()
      expect(
        yield* runs.transition({
          id: admitted.id,
          ownerID: "process-foreign",
          state: { type: "succeeded" },
        }),
      ).toBeUndefined()
      expect(yield* runs.touch({ id: admitted.id, ownerID: "process-foreign" })).toBeUndefined()
      expect(
        yield* runs.summarize({
          id: admitted.id,
          ownerID: "process-foreign",
          revision: 0,
          summary: "Foreign summary",
        }),
      ).toBeUndefined()

      expect(yield* runs.get(admitted.id)).toEqual(admitted)
      expect(
        yield* runs.transition({
          id: admitted.id,
          ownerID: "process-live",
          state: { type: "succeeded" },
        }),
      ).toMatchObject({ state: { type: "succeeded" } })
    }),
  )

  it.effect("snapshots active runs and the 100 most recent terminal runs", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const runs = yield* AgentRun.Service
      const siblingSessionID = SessionV2.ID.make("ses_agent_run_sibling")
      const grandchildSessionID = SessionV2.ID.make("ses_agent_run_grandchild")
      const unrelatedRootID = SessionV2.ID.make("ses_agent_run_unrelated_root")
      const unrelatedChildID = SessionV2.ID.make("ses_agent_run_unrelated_child")
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: siblingSessionID,
            project_id: ProjectV2.ID.global,
            parent_id: rootSessionID,
            slug: "sibling",
            directory: "/project",
            title: "Sibling",
            version: "test",
            agent: "build",
            time_created: 3,
            time_updated: 3,
          },
          {
            id: grandchildSessionID,
            project_id: ProjectV2.ID.global,
            parent_id: childSessionID,
            slug: "grandchild",
            directory: "/project",
            title: "Grandchild",
            version: "test",
            time_created: 4,
            time_updated: 4,
          },
          {
            id: unrelatedRootID,
            project_id: ProjectV2.ID.global,
            slug: "unrelated-root",
            directory: "/project",
            title: "Unrelated root",
            version: "test",
            time_created: 5,
            time_updated: 5,
          },
          {
            id: unrelatedChildID,
            project_id: ProjectV2.ID.global,
            parent_id: unrelatedRootID,
            slug: "unrelated-child",
            directory: "/project",
            title: "Unrelated child",
            version: "test",
            time_created: 6,
            time_updated: 6,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      const admit = (sessionID: SessionV2.ID, label: string) =>
        admitInfo(runs, {
          sessionID,
          callerSessionID: rootSessionID,
          source: { messageID: SessionMessage.ID.make(`msg_agent_run_snapshot_${label}`), callID: label },
          agent: AgentV2.ID.make("review"),
          description: label,
          background: true,
          ownerID: "process-1",
        })

      const activeChild = yield* admit(childSessionID, "active-child")
      yield* TestClock.adjust(Duration.seconds(1))
      const activeGrandchild = yield* admit(grandchildSessionID, "active-grandchild")
      const terminal = yield* Effect.forEach(
        Array.from({ length: 112 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.seconds(1))
            const admitted = yield* admit(index % 2 === 0 ? childSessionID : siblingSessionID, `terminal-${index}`)
            return yield* runs.transition({
              id: admitted.id,
              ownerID: "process-1",
              state: { type: "succeeded" },
            })
          }),
      )
      const unrelated = yield* admitInfo(runs, {
        sessionID: unrelatedChildID,
        callerSessionID: unrelatedRootID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_snapshot_unrelated"), callID: "unrelated" },
        agent: AgentV2.ID.make("review"),
        description: "Unrelated",
        background: true,
        ownerID: "process-1",
      })

      const snapshot = yield* runs.snapshot(rootSessionID)

      expect(snapshot.rootSessionID).toBe(rootSessionID)
      expect(
        snapshot.nodes.map((node) => ({
          sessionID: node.sessionID,
          parentSessionID: node.parentSessionID,
          title: node.title,
          agent: node.agent,
          createdAt: DateTime.toEpochMillis(node.createdAt),
        })),
      ).toEqual([
        {
          sessionID: childSessionID,
          parentSessionID: rootSessionID,
          title: "Child",
          agent: AgentV2.ID.make("review"),
          createdAt: 2,
        },
        {
          sessionID: siblingSessionID,
          parentSessionID: rootSessionID,
          title: "Sibling",
          agent: AgentV2.ID.make("build"),
          createdAt: 3,
        },
        {
          sessionID: grandchildSessionID,
          parentSessionID: childSessionID,
          title: "Grandchild",
          agent: undefined,
          createdAt: 4,
        },
      ])
      expect(snapshot.active.map((run) => run.id)).toEqual([activeChild.id, activeGrandchild.id])
      expect(snapshot.active.some((run) => run.id === unrelated.id)).toBe(false)
      expect(snapshot.history.map((run) => run.id)).toEqual(
        terminal
          .flatMap((run) => (run ? [run.id] : []))
          .toReversed()
          .slice(0, 100),
      )
    }),
  )

  it.effect("terminates a recursive snapshot when Session parent links contain a cycle", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const runs = yield* AgentRun.Service
      const grandchildSessionID = SessionV2.ID.make("ses_agent_run_cycle_grandchild")
      yield* db
        .insert(SessionTable)
        .values({
          id: grandchildSessionID,
          project_id: ProjectV2.ID.global,
          parent_id: childSessionID,
          slug: "cycle-grandchild",
          directory: "/project",
          title: "Cycle grandchild",
          version: "test",
          time_created: 3,
          time_updated: 3,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ parent_id: grandchildSessionID })
        .where(eq(SessionTable.id, rootSessionID))
        .run()
        .pipe(Effect.orDie)

      const snapshot = yield* runs.snapshot(rootSessionID)

      expect(snapshot.nodes).toEqual([])
      expect(snapshot.active).toEqual([])
      expect(snapshot.history).toEqual([])
    }),
  )

  effectIt.live("reads active and history from one database snapshot during a concurrent transition", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const activeRead = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const hookedAgentRun = LayerNode.make({
        service: AgentRun.Service,
        layer: AgentRun.layerWith({
          afterActiveRead: Deferred.succeed(activeRead, undefined).pipe(Effect.andThen(Deferred.await(release))),
        }),
        deps: [Database.node, EventV2.node],
      })
      const readerLayer = LayerNode.compile(LayerNode.group([Database.node, EventV2.node, hookedAgentRun]), [
        [Database.node, Layer.fresh(Database.layerFromPath(path.join(tmp.path, "agent-run.sqlite")))],
      ])
      const writerLayer = LayerNode.compile(LayerNode.group([Database.node, EventV2.node, AgentRun.node]), [
        [Database.node, Layer.fresh(Database.layerFromPath(path.join(tmp.path, "agent-run.sqlite")))],
      ])
      const writer = Context.get(yield* Layer.build(writerLayer), AgentRun.Service)

      yield* Effect.gen(function* () {
        yield* setup
        const reader = yield* AgentRun.Service
        const admitted = yield* admitInfo(reader, {
          sessionID: childSessionID,
          callerSessionID: rootSessionID,
          source: { messageID: SessionMessage.ID.make("msg_agent_run_snapshot_atomic"), callID: "call_1" },
          agent: AgentV2.ID.make("review"),
          description: "Transition during snapshot",
          background: true,
          ownerID: "process-1",
        })
        const snapshotFiber = yield* reader.snapshot(rootSessionID).pipe(Effect.forkChild)
        yield* Deferred.await(activeRead)

        expect(
          yield* writer.transition({ id: admitted.id, ownerID: "process-1", state: { type: "succeeded" } }),
        ).toMatchObject({ state: { type: "succeeded" } })
        yield* Deferred.succeed(release, undefined)
        const snapshot = yield* Fiber.join(snapshotFiber)

        expect(snapshot.active.map((run) => run.id)).toContain(admitted.id)
        expect(snapshot.history.map((run) => run.id)).not.toContain(admitted.id)
        expect(yield* reader.get(admitted.id)).toMatchObject({ state: { type: "succeeded" } })
      }).pipe(Effect.provide(readerLayer))
    }),
  )
})
