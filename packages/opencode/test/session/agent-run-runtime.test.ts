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
import { AgentRunRuntime } from "@/session/agent-run-runtime"
import { AgentRunSummary } from "@/session/agent-run-summary"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, EventV2.node, AgentRun.node])))
const rootSessionID = SessionV2.ID.make("ses_agent_run_runtime_root")
const childSessionID = SessionV2.ID.make("ses_agent_run_runtime_child")

const seed = Effect.gen(function* () {
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
        time_created: 2,
        time_updated: 2,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const noopSummaryLayer = Layer.succeed(
  AgentRunSummary.Service,
  AgentRunSummary.Service.of({ watch: () => Effect.succeed({ refresh: Effect.void }) }),
)

const runtimeLayer = (
  runs: AgentRun.Interface,
  events: EventV2.Interface,
  summary: Layer.Layer<AgentRunSummary.Service> = noopSummaryLayer,
) =>
  LayerNode.compile(AgentRunRuntime.node, [
    [AgentRun.node, Layer.succeed(AgentRun.Service, runs)],
    [EventV2.node, Layer.succeed(EventV2.Service, events)],
    [AgentRunSummary.node, summary],
  ])

describe("AgentRunRuntime", () => {
  it.effect("does not treat another live runtime owner as lost", () =>
    Effect.gen(function* () {
      yield* seed
      const runs = yield* AgentRun.Service
      const events = yield* EventV2.Service
      const firstScope = yield* Scope.make()
      const firstContext = yield* Layer.buildWithScope(Layer.fresh(runtimeLayer(runs, events)), firstScope)
      const first = Context.get(firstContext, AgentRunRuntime.Service)
      const admitted = yield* first.admit({
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_runtime_live_owner"), callID: "call_live_owner" },
        agent: AgentV2.ID.make("review"),
        description: "Keep a live owner",
        background: true,
      })
      const started = yield* Deferred.make<void>()
      const execution = yield* first
        .execute({
          id: admitted.info.id,
          sessionID: childSessionID,
          effect: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const secondScope = yield* Scope.make()
      const secondContext = yield* Layer.buildWithScope(Layer.fresh(runtimeLayer(runs, events)), secondScope)
      const second = Context.get(secondContext, AgentRunRuntime.Service)

      expect(second.ownerID).not.toBe(first.ownerID)
      expect((yield* runs.get(admitted.info.id))?.state).toEqual({ type: "running" })
      yield* Scope.close(secondScope, Exit.void)
      expect((yield* runs.get(admitted.info.id))?.state).toEqual({ type: "running" })

      yield* Scope.close(firstScope, Exit.void)
      expect((yield* runs.get(admitted.info.id))?.state).toEqual({
        type: "interrupted",
        reason: "runtime_shutdown",
      })
      yield* Fiber.interrupt(execution)
    }),
  )

  it.effect("interrupts still-active owned runs when the runtime stops", () =>
    Effect.gen(function* () {
      yield* seed
      const runs = yield* AgentRun.Service
      const events = yield* EventV2.Service
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(runtimeLayer(runs, events), scope)
      const runtime = Context.get(context, AgentRunRuntime.Service)
      const admitted = yield* runtime.admit({
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_runtime_shutdown"), callID: "call_shutdown" },
        agent: AgentV2.ID.make("review"),
        description: "Finish before shutdown",
        background: true,
      })

      expect(admitted.info.state).toEqual({ type: "running" })
      yield* Scope.close(scope, Exit.void)

      expect((yield* runs.get(admitted.info.id))?.state).toEqual({
        type: "interrupted",
        reason: "runtime_shutdown",
      })
    }),
  )

  it.effect("terminalizes interruption while execution start is being acquired", () =>
    Effect.gen(function* () {
      yield* seed
      const runs = yield* AgentRun.Service
      const events = yield* EventV2.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const delayedRuns = AgentRun.Service.of({
        ...runs,
        start: (input) =>
          runs.start(input).pipe(
            Effect.tap(() => Deferred.succeed(started, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
      })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(runtimeLayer(delayedRuns, events), scope)
      const runtime = Context.get(context, AgentRunRuntime.Service)
      const admitted = yield* runtime.admit({
        sessionID: childSessionID,
        callerSessionID: rootSessionID,
        source: { messageID: SessionMessage.ID.make("msg_runtime_start_interrupt"), callID: "call_start_interrupt" },
        agent: AgentV2.ID.make("review"),
        description: "Interrupt while starting",
        background: true,
      })
      const fiber = yield* runtime
        .execute({ id: admitted.info.id, sessionID: childSessionID, effect: Effect.never })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupt)

      expect((yield* runs.get(admitted.info.id))?.state).toEqual({
        type: "interrupted",
        reason: "execution_interrupted",
      })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("watches each run and refreshes without blocking terminal state on summary failure or timeout", () =>
    Effect.gen(function* () {
      yield* seed
      const runs = yield* AgentRun.Service
      const events = yield* EventV2.Service
      const timeoutStarted = yield* Deferred.make<void>()
      const watched = new Array<AgentRunSummary.Input>()
      const refreshed = new Array<{ id: AgentRun.ID; state: AgentRun.State["type"] | undefined }>()
      let closed = 0
      const summary = Layer.succeed(
        AgentRunSummary.Service,
        AgentRunSummary.Service.of({
          watch: (input) =>
            Effect.gen(function* () {
              const index = watched.length
              watched.push(input)
              yield* Effect.addFinalizer(() => Effect.sync(() => (closed += 1)))
              const observe = Effect.gen(function* () {
                refreshed.push({ id: input.runID, state: (yield* runs.get(input.runID))?.state.type })
              })
              return {
                refresh:
                  index === 0
                    ? observe.pipe(Effect.andThen(Effect.die(new Error("summary refresh failed"))))
                    : observe.pipe(
                        Effect.andThen(Deferred.succeed(timeoutStarted, undefined)),
                        Effect.andThen(Effect.never),
                      ),
              }
            }),
        }),
      )
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(runtimeLayer(runs, events, summary), scope)
      const runtime = Context.get(context, AgentRunRuntime.Service)
      const model = ProviderTest.model({
        id: ModelV2.ID.make("summary-runtime-model"),
        providerID: ProviderV2.ID.make("summary-runtime-provider"),
      })
      const admit = (callID: string) =>
        runtime.admit({
          sessionID: childSessionID,
          callerSessionID: rootSessionID,
          source: { messageID: SessionMessage.ID.make(`msg_runtime_${callID}`), callID },
          agent: AgentV2.ID.make("review"),
          description: "Summarize runtime activity",
          background: true,
        })

      const failed = yield* admit("summary_failure")
      const failedExit = yield* runtime
        .execute({
          id: failed.info.id,
          sessionID: childSessionID,
          model,
          effect: Effect.fail(new Error("prompt failed")),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(failedExit)).toBe(true)
      expect(watched[0]).toMatchObject({
        runID: failed.info.id,
        childSessionID,
        ownerID: runtime.ownerID,
        model,
      })
      expect(refreshed[0]).toEqual({ id: failed.info.id, state: "running" })
      expect((yield* runs.get(failed.info.id))?.state).toEqual({ type: "failed", error: "prompt failed" })
      expect(closed).toBe(1)

      const succeeded = yield* admit("summary_timeout")
      const fiber = yield* runtime
        .execute({
          id: succeeded.info.id,
          sessionID: childSessionID,
          model,
          effect: Effect.succeed("done"),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(timeoutStarted)
      expect((yield* runs.get(succeeded.info.id))?.state).toEqual({ type: "running" })

      yield* TestClock.adjust("10 seconds")

      expect(yield* Fiber.join(fiber)).toBe("done")
      expect(refreshed[1]).toEqual({ id: succeeded.info.id, state: "running" })
      expect((yield* runs.get(succeeded.info.id))?.state).toEqual({ type: "succeeded" })
      expect(closed).toBe(2)
      yield* Scope.close(scope, Exit.void)
    }),
  )
})
