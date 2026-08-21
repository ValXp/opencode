import { describe, expect } from "bun:test"
import { AgentRun } from "@opencode-ai/core/agent-run"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Context, DateTime, Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
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

describe("AgentRun overview", () => {
  it.effect("returns queued and retrying runs across session trees with their ancestors", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const runs = yield* AgentRun.Service
      const secondRootID = SessionV2.ID.make("ses_agent_run_overview_second_root")
      const secondBranchID = SessionV2.ID.make("ses_agent_run_overview_second_branch")
      const secondLeafID = SessionV2.ID.make("ses_agent_run_overview_second_leaf")
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: secondRootID,
            project_id: ProjectV2.ID.global,
            slug: "overview-second-root",
            directory: "/project",
            title: "Second root",
            version: "test",
            time_created: 10,
            time_updated: 10,
          },
          {
            id: secondBranchID,
            project_id: ProjectV2.ID.global,
            parent_id: secondRootID,
            slug: "overview-second-branch",
            directory: "/project",
            title: "Second branch",
            version: "test",
            agent: "build",
            time_created: 11,
            time_updated: 11,
          },
          {
            id: secondLeafID,
            project_id: ProjectV2.ID.global,
            parent_id: secondBranchID,
            slug: "overview-second-leaf",
            directory: "/project",
            title: "Second leaf",
            version: "test",
            agent: "review",
            time_created: 12,
            time_updated: 12,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const queued = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_queued"), callID: "queued" },
        agent: AgentV2.ID.make("review"),
        description: "Queued on the first tree",
        background: true,
        ownerID: "process-1",
      })
      yield* TestClock.adjust(Duration.seconds(1))
      const terminal = yield* admitInfo(runs, {
        sessionID: secondBranchID,
        callerSessionID: secondRootID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_terminal"), callID: "terminal" },
        agent: AgentV2.ID.make("build"),
        description: "Finished on the second tree",
        background: false,
        ownerID: "process-1",
      })
      yield* runs.transition({ id: terminal.id, ownerID: "process-1", state: { type: "succeeded" } })
      yield* TestClock.adjust(Duration.seconds(1))
      const admittedRetry = yield* admitInfo(runs, {
        sessionID: secondLeafID,
        callerSessionID: secondBranchID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_retrying"), callID: "retrying" },
        agent: AgentV2.ID.make("review"),
        description: "Retrying on the second tree",
        background: true,
        ownerID: "process-1",
      })
      const retrying = yield* runs.transition({
        id: admittedRetry.id,
        ownerID: "process-1",
        state: {
          type: "retrying",
          attempt: 1,
          message: "Provider overloaded",
          next: DateTime.makeUnsafe(3_000),
        },
      })

      const overview = yield* runs.overview()

      if (retrying === undefined) throw new Error("Expected retrying transition")
      expect(overview.nodes.map((node) => node.sessionID)).toEqual([childSessionID, secondBranchID, secondLeafID])
      expect(overview.active.map((run) => run.id)).toEqual([queued.id, admittedRetry.id])
      expect(overview.active[0]?.time.started).toBeUndefined()
      expect(overview.active[1]?.state).toEqual(retrying.state)
      expect(overview.history.map((run) => run.id)).toEqual([terminal.id])
    }),
  )

  it.effect("limits history to the latest 100 terminal runs across roots", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const runs = yield* AgentRun.Service
      const secondRootID = SessionV2.ID.make("ses_agent_run_overview_history_root")
      const secondChildID = SessionV2.ID.make("ses_agent_run_overview_history_child")
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: secondRootID,
            project_id: ProjectV2.ID.global,
            slug: "overview-history-root",
            directory: "/project",
            title: "History root",
            version: "test",
            time_created: 20,
            time_updated: 20,
          },
          {
            id: secondChildID,
            project_id: ProjectV2.ID.global,
            parent_id: secondRootID,
            slug: "overview-history-child",
            directory: "/project",
            title: "History child",
            version: "test",
            time_created: 21,
            time_updated: 21,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const terminal = yield* Effect.forEach(
        Array.from({ length: 102 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.seconds(1))
            const secondTree = index % 2 === 1
            const admitted = yield* admitInfo(runs, {
              sessionID: secondTree ? secondChildID : childSessionID,
              callerSessionID: secondTree ? secondRootID : rootSessionID,
              source: {
                messageID: SessionMessage.ID.make(`msg_agent_run_overview_history_${index}`),
                callID: `history-${index}`,
              },
              agent: AgentV2.ID.make("review"),
              description: `History ${index}`,
              background: true,
              ownerID: "process-1",
            })
            return yield* runs.transition({
              id: admitted.id,
              ownerID: "process-1",
              state: { type: "succeeded" },
            })
          }),
      )

      const overview = yield* runs.overview()

      expect(overview.nodes.map((node) => node.sessionID)).toEqual([childSessionID, secondChildID])
      expect(overview.active).toEqual([])
      expect(overview.history.map((run) => run.id)).toEqual(
        terminal
          .flatMap((run) => (run ? [run.id] : []))
          .toReversed()
          .slice(0, 100),
      )
    }),
  )

  it.effect("includes an old terminal successor needed to reconcile a stale active predecessor", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const runs = yield* AgentRun.Service
      const unrelatedSessionID = SessionV2.ID.make("ses_agent_run_overview_reconciliation_unrelated")
      yield* db
        .insert(SessionTable)
        .values({
          id: unrelatedSessionID,
          project_id: ProjectV2.ID.global,
          parent_id: rootSessionID,
          slug: "overview-reconciliation-unrelated",
          directory: "/project",
          title: "Unrelated terminal history",
          version: "test",
          time_created: 3,
          time_updated: 3,
        })
        .run()
        .pipe(Effect.orDie)

      const predecessor = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_predecessor"), callID: "predecessor" },
        agent: AgentV2.ID.make("review"),
        description: "Stale active predecessor",
        background: true,
        ownerID: "process-1",
      })
      yield* TestClock.adjust(Duration.seconds(1))
      const successor = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_successor"), callID: "successor" },
        agent: AgentV2.ID.make("review"),
        description: "Terminal successor",
        background: true,
        ownerID: "process-1",
      })
      yield* runs.transition({ id: successor.id, ownerID: "process-1", state: { type: "succeeded" } })
      const newer = yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.seconds(1))
            const admitted = yield* admitInfo(runs, {
              sessionID: unrelatedSessionID,
              callerSessionID: rootSessionID,
              source: {
                messageID: SessionMessage.ID.make(`msg_agent_run_overview_newer_${index}`),
                callID: `newer-${index}`,
              },
              agent: AgentV2.ID.make("review"),
              description: `Newer terminal ${index}`,
              background: true,
              ownerID: "process-1",
            })
            return yield* runs.transition({
              id: admitted.id,
              ownerID: "process-1",
              state: { type: "succeeded" },
            })
          }),
      )
      yield* TestClock.adjust(Duration.seconds(1))
      const queued = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_queued_successor"), callID: "queued" },
        agent: AgentV2.ID.make("review"),
        description: "Queued after terminal reconciliation",
        background: true,
        ownerID: "process-1",
      })

      const overview = yield* runs.overview()

      expect(successor.previousRunID).toBe(predecessor.id)
      expect(queued.previousRunID).toBe(successor.id)
      expect(overview.active.map((run) => run.id)).toEqual([predecessor.id, queued.id])
      expect(overview.history.slice(0, 100).map((run) => run.id)).toEqual(
        newer
          .flatMap((run) => (run ? [run.id] : []))
          .toReversed()
          .slice(0, 100),
      )
      expect(overview.history.at(-1)?.id).toBe(successor.id)
      expect(overview.history).toHaveLength(101)
    }),
  )

  it.effect("terminates an ancestor walk when Session parent links contain a cycle", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const runs = yield* AgentRun.Service
      yield* db
        .update(SessionTable)
        .set({ parent_id: childSessionID })
        .where(eq(SessionTable.id, rootSessionID))
        .run()
        .pipe(Effect.orDie)
      const admitted = yield* admitInfo(runs, {
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_cycle"), callID: "cycle" },
        agent: AgentV2.ID.make("review"),
        description: "Survive a session cycle",
        background: true,
        ownerID: "process-1",
      })

      const overview = yield* runs.overview()

      expect(overview.nodes.map((node) => node.sessionID)).toEqual([rootSessionID, childSessionID])
      expect(overview.active.map((run) => run.id)).toEqual([admitted.id])
      expect(overview.history).toEqual([])
    }),
  )

  it.effect("resolves comma-containing session IDs and shared ancestors exactly once", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const runs = yield* AgentRun.Service
      const sharedID = SessionV2.ID.make("ses_agent_run_overview_shared")
      const separatorAncestorID = SessionV2.ID.make("ses_separator_ancestor")
      const separatorMiddleID = SessionV2.ID.make("ses_prefix,ses_separator_ancestor")
      const separatorLeafID = SessionV2.ID.make("ses_agent_run_overview_separator_leaf")
      const siblingAID = SessionV2.ID.make("ses_agent_run_overview_shared_a")
      const siblingBID = SessionV2.ID.make("ses_agent_run_overview_shared_b")
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: sharedID,
            project_id: ProjectV2.ID.global,
            parent_id: rootSessionID,
            slug: "overview-shared",
            directory: "/project",
            title: "Shared ancestor",
            version: "test",
            time_created: 3,
            time_updated: 3,
          },
          {
            id: separatorAncestorID,
            project_id: ProjectV2.ID.global,
            parent_id: sharedID,
            slug: "overview-separator-ancestor",
            directory: "/project",
            title: "Separator ancestor",
            version: "test",
            time_created: 4,
            time_updated: 4,
          },
          {
            id: separatorMiddleID,
            project_id: ProjectV2.ID.global,
            parent_id: separatorAncestorID,
            slug: "overview-separator-middle",
            directory: "/project",
            title: "Separator middle",
            version: "test",
            time_created: 5,
            time_updated: 5,
          },
          {
            id: separatorLeafID,
            project_id: ProjectV2.ID.global,
            parent_id: separatorMiddleID,
            slug: "overview-separator-leaf",
            directory: "/project",
            title: "Separator leaf",
            version: "test",
            time_created: 6,
            time_updated: 6,
          },
          {
            id: siblingAID,
            project_id: ProjectV2.ID.global,
            parent_id: sharedID,
            slug: "overview-shared-a",
            directory: "/project",
            title: "Shared branch A",
            version: "test",
            time_created: 7,
            time_updated: 7,
          },
          {
            id: siblingBID,
            project_id: ProjectV2.ID.global,
            parent_id: sharedID,
            slug: "overview-shared-b",
            directory: "/project",
            title: "Shared branch B",
            version: "test",
            time_created: 8,
            time_updated: 8,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        [separatorLeafID, siblingAID, siblingBID],
        (sessionID, index) =>
          admitInfo(runs, {
            sessionID,
            callerSessionID: sessionID === separatorLeafID ? separatorMiddleID : sharedID,
            source: {
              messageID: SessionMessage.ID.make(`msg_agent_run_overview_ancestor_${index}`),
              callID: `ancestor-${index}`,
            },
            agent: AgentV2.ID.make("review"),
            description: `Ancestor run ${index}`,
            background: true,
            ownerID: "process-1",
          }),
        { discard: true },
      )

      const overview = yield* runs.overview()

      expect(overview.nodes.map((node) => node.sessionID)).toEqual([
        sharedID,
        separatorAncestorID,
        separatorMiddleID,
        separatorLeafID,
        siblingAID,
        siblingBID,
      ])
      expect(overview.nodes.filter((node) => node.sessionID === sharedID)).toHaveLength(1)
    }),
  )

  effectIt.live("reads one database snapshot during a concurrent transition", () =>
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
          source: { messageID: SessionMessage.ID.make("msg_agent_run_overview_atomic"), callID: "call_1" },
          agent: AgentV2.ID.make("review"),
          description: "Transition during overview",
          background: true,
          ownerID: "process-1",
        })
        const overviewFiber = yield* reader.overview().pipe(Effect.forkChild)
        yield* Deferred.await(activeRead)

        expect(
          yield* writer.transition({ id: admitted.id, ownerID: "process-1", state: { type: "succeeded" } }),
        ).toMatchObject({ state: { type: "succeeded" } })
        yield* Deferred.succeed(release, undefined)
        const overview = yield* Fiber.join(overviewFiber)

        expect(overview.active.map((run) => run.id)).toContain(admitted.id)
        expect(overview.history.map((run) => run.id)).not.toContain(admitted.id)
        expect(yield* reader.get(admitted.id)).toMatchObject({ state: { type: "succeeded" } })
      }).pipe(Effect.provide(readerLayer))
    }),
  )
})
