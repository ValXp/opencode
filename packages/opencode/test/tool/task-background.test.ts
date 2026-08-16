import { AgentRun } from "@opencode-ai/core/agent-run"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { afterEach, describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Schema } from "effect"
import type { SessionPrompt } from "../../src/session/prompt"
import { PartID } from "../../src/session/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { background, defer, it, reply, schedulingFailure, seed, stubOps, taskJobID } from "./task.fixture"

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.task", () => {
  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("durably tracks a fresh background task from admission through success", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const callID = "call_fresh_background"
      let toolPartRunID: unknown

      const result = yield* def.execute(
        {
          description: "inspect lifecycle",
          prompt: "trace the lifecycle",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                Deferred.succeed(ready, undefined).pipe(
                  Effect.andThen(Deferred.await(done)),
                  Effect.as(reply(input, "tracked result")),
                ),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: (input) => Effect.sync(() => (toolPartRunID = input.metadata?.runId)),
          ask: () => Effect.void,
        },
      )
      yield* Deferred.await(ready)

      const admitted = yield* runs.findBySource({
        callerSessionID: chat.id,
        source: { messageID: SessionMessage.ID.make(assistant.id), callID },
      })
      expect(admitted).toMatchObject({
        id: result.metadata.runId,
        sessionID: result.metadata.sessionId,
        callerSessionID: chat.id,
        source: { messageID: assistant.id, callID },
        background: true,
        state: { type: "running" },
      })
      expect(admitted?.time.started).toBeDefined()
      expect(toolPartRunID).toBe(result.metadata.runId)
      expect(taskJobID(result)).toBe(result.metadata.sessionId)
      expect((yield* jobs.get(taskJobID(result)))?.metadata?.runId).toBe(result.metadata.runId)

      yield* Deferred.succeed(done, undefined)
      const waited = yield* jobs.wait({ id: taskJobID(result), timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect((yield* runs.get(result.metadata.runId))?.state).toEqual({ type: "succeeded" })
    }),
  )

  schedulingFailure.instance("terminalizes a durable run when background scheduling fails", () =>
    Effect.gen(function* () {
      const runs = yield* AgentRun.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "call_scheduling_failure"

      const exit = yield* def
        .execute(
          {
            description: "inspect scheduling failure",
            prompt: "this task must not remain active",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const admitted = yield* runs.findBySource({
        callerSessionID: chat.id,
        source: { messageID: SessionMessage.ID.make(assistant.id), callID },
      })
      expect(admitted?.state).toEqual({ type: "failed", error: "scheduler unavailable" })
      expect(admitted?.time.finished).toBeDefined()
    }),
  )

  it.instance("exact replay returns the existing run without duplicating work or a child", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        callID: "call_exact_replay",
        agent: "build",
        abort: new AbortController().signal,
        extra: {
          promptOps: stubOps({
            text: "original result",
            onPrompt: () => {
              prompts += 1
            },
          }),
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const params = {
        description: "inspect replay",
        prompt: "trace the exact source",
        subagent_type: "general",
      }

      const first = yield* def.execute(params, context)
      const replayed = yield* def.execute(params, context)

      expect(prompts).toBe(1)
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
      expect(yield* jobs.list()).toHaveLength(1)
      expect(replayed.metadata.sessionId).toBe(first.metadata.sessionId)
      expect(replayed.metadata.runId).toBe(first.metadata.runId)
      expect(first.output).toContain("original result")
      expect(replayed.output).toBe(first.output)
    }),
  )

  it.instance("durably replays settled foreground output and errors without local jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      const promptOps = stubOps({
        onPrompt: () => {
          prompts += 1
        },
      })

      const successCallID = "call_durable_success"
      const successChild = yield* sessions.create({ parentID: chat.id, title: "Successful child" })
      const success = yield* runs.admit({
        sessionID: successChild.id,
        callerSessionID: chat.id,
        source: { messageID: SessionMessage.ID.make(assistant.id), callID: successCallID },
        agent: AgentV2.ID.make("general"),
        description: "durable success",
        background: false,
        ownerID: "test-process",
      })
      yield* runs.transition({ id: success.info.id, ownerID: "test-process", state: { type: "succeeded" } })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistant.id,
        type: "tool",
        callID: successCallID,
        tool: "task",
        state: {
          status: "completed",
          input: {},
          output: "persisted exact output",
          title: "durable success",
          metadata: { runId: success.info.id },
          time: { start: 1, end: 2 },
        },
      })

      const successReplay = yield* def.execute(
        { description: "durable success", prompt: "do not run", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: successCallID,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(successReplay.output).toBe("persisted exact output")

      const errorCallID = "call_durable_error"
      const errorChild = yield* sessions.create({ parentID: chat.id, title: "Failed child" })
      const failed = yield* runs.admit({
        sessionID: errorChild.id,
        callerSessionID: chat.id,
        source: { messageID: SessionMessage.ID.make(assistant.id), callID: errorCallID },
        agent: AgentV2.ID.make("general"),
        description: "durable error",
        background: false,
        ownerID: "test-process",
      })
      yield* runs.transition({
        id: failed.info.id,
        ownerID: "test-process",
        state: { type: "failed", error: "persisted exact error" },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistant.id,
        type: "tool",
        callID: errorCallID,
        tool: "task",
        state: {
          status: "error",
          input: {},
          error: "persisted exact error",
          time: { start: 3, end: 4 },
        },
      })

      const errorReplay = yield* def
        .execute(
          { description: "durable error", prompt: "do not run", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: errorCallID,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(errorReplay)).toBe(true)
      if (Exit.isFailure(errorReplay)) {
        expect(String(Cause.squash(errorReplay.cause))).toContain("persisted exact error")
      }
      expect(prompts).toBe(0)
      expect(yield* jobs.list()).toHaveLength(0)
      expect(yield* sessions.children(chat.id)).toHaveLength(2)
    }),
  )

  it.instance("concurrent exact replay removes the losing child and executes once", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const gate = yield* Deferred.make<void>()
      let arrivals = 0
      let prompts = 0
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        callID: "call_concurrent_replay",
        agent: "build",
        abort: new AbortController().signal,
        extra: {
          promptOps: stubOps({
            onPrompt: () => {
              prompts += 1
            },
          }),
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () =>
          Effect.gen(function* () {
            arrivals += 1
            if (arrivals === 2) yield* Deferred.succeed(gate, undefined)
            yield* Deferred.await(gate)
          }),
      }
      const params = {
        description: "race replay",
        prompt: "execute only once",
        subagent_type: "general",
      }

      const results = yield* Effect.all([def.execute(params, context), def.execute(params, context)], {
        concurrency: "unbounded",
      })

      expect(prompts).toBe(1)
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
      expect(new Set(results.map((result) => result.metadata.sessionId)).size).toBe(1)
      expect(new Set(results.map((result) => result.metadata.runId)).size).toBe(1)
    }),
  )

  background.instance("marks a queued foreground resumption detached without starting it before its turn", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const firstReady = yield* Deferred.make<void>()
      const firstDone = yield* Deferred.make<void>()
      const secondReady = yield* Deferred.make<void>()
      const secondDone = yield* Deferred.make<void>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) return Effect.never
          prompts += 1
          if (prompts === 1) {
            return Deferred.succeed(firstReady, undefined).pipe(
              Effect.andThen(Deferred.await(firstDone)),
              Effect.as(reply(input, "first result")),
            )
          }
          return Deferred.succeed(secondReady, undefined).pipe(
            Effect.andThen(Deferred.await(secondDone)),
            Effect.as(reply(input, "second result")),
          )
        },
      }
      const context = (callID: string) => ({
        sessionID: chat.id,
        messageID: assistant.id,
        callID,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      const first = yield* def.execute(
        {
          description: "inspect lifecycle",
          prompt: "run the first pass",
          subagent_type: "general",
          background: true,
        },
        context("call_resume_first"),
      )
      yield* Deferred.await(firstReady)
      const second = yield* def.execute(
        {
          description: "extend lifecycle",
          prompt: "run the second pass",
          subagent_type: "general",
          task_id: first.metadata.sessionId,
        },
        context("call_resume_second"),
      )

      const queued = yield* runs.get(second.metadata.runId)
      expect(queued?.previousRunID).toBe(first.metadata.runId)
      expect(queued?.background).toBe(true)
      expect(queued?.time.started).toBeUndefined()
      expect(prompts).toBe(1)
      expect(second.metadata.sessionId).toBe(first.metadata.sessionId)
      expect(taskJobID(second)).toBe(taskJobID(first))

      yield* Deferred.succeed(firstDone, undefined)
      yield* Deferred.await(secondReady)
      expect((yield* runs.get(second.metadata.runId))?.time.started).toBeDefined()

      yield* Deferred.succeed(secondDone, undefined)
      expect((yield* jobs.wait({ id: taskJobID(first), timeout: 1_000 })).info?.status).toBe("completed")
      expect((yield* runs.get(first.metadata.runId))?.state).toEqual({ type: "succeeded" })
      expect((yield* runs.get(second.metadata.runId))?.state).toEqual({ type: "succeeded" })
    }),
  )

  background.instance("projects child retry and recovery status onto the active run", () =>
    Effect.gen(function* () {
      const runs = yield* AgentRun.Service
      const status = yield* SessionStatus.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const next = Date.now() + 1_000

      const result = yield* def.execute(
        {
          description: "inspect retries",
          prompt: "wait through a retry",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call_retry_status",
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                Deferred.succeed(ready, undefined).pipe(
                  Effect.andThen(Deferred.await(done)),
                  Effect.as(reply(input, "recovered")),
                ),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      yield* Deferred.await(ready)

      yield* status.set(result.metadata.sessionId, {
        type: "retry",
        attempt: 2,
        message: "Provider rate limited",
        next,
      })
      const retrying = yield* runs.get(result.metadata.runId)
      expect(retrying?.state.type).toBe("retrying")
      if (retrying?.state.type === "retrying") {
        expect(retrying.state.attempt).toBe(2)
        expect(retrying.state.message).toBe("Provider rate limited")
        expect(DateTime.toEpochMillis(retrying.state.next)).toBe(next)
      }

      yield* status.set(result.metadata.sessionId, { type: "busy" })
      expect((yield* runs.get(result.metadata.runId))?.state).toEqual({ type: "running" })

      yield* Deferred.succeed(done, undefined)
    }),
  )

  background.instance("records a bounded safe message for an ordinary task failure", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const message = "Provider request failed: " + "x".repeat(3_000)

      const result = yield* def.execute(
        {
          description: "inspect failure",
          prompt: "fail this task",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call_task_failure",
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.fail(new Error(message)),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect((yield* jobs.wait({ id: taskJobID(result), timeout: 1_000 })).info?.status).toBe("error")
      const failed = yield* runs.get(result.metadata.runId)
      expect(failed?.state.type).toBe("failed")
      if (failed?.state.type === "failed") {
        expect(failed.state.error).toStartWith("Provider request failed")
        expect(failed.state.error.length).toBeLessThanOrEqual(2_000)
        expect(failed.state.error).not.toContain("\n    at ")
      }
    }),
  )

  background.instance("records an execution defect as a failed run", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect defect",
          prompt: "defect this task",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call_task_defect",
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.die(new Error("Prompt execution defect")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect((yield* jobs.wait({ id: taskJobID(result), timeout: 1_000 })).info?.status).toBe("error")
      expect((yield* runs.get(result.metadata.runId))?.state).toEqual({
        type: "failed",
        error: "Prompt execution defect",
      })
    }),
  )

  background.instance("records mechanical task interruption without overwriting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()

      const result = yield* def.execute(
        {
          description: "inspect interruption",
          prompt: "wait to be interrupted",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call_task_interruption",
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      yield* Deferred.await(ready)

      expect((yield* jobs.cancel(taskJobID(result)))?.status).toBe("cancelled")
      expect((yield* runs.get(result.metadata.runId))?.state).toEqual({
        type: "interrupted",
        reason: "execution_interrupted",
      })
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const events = yield* EventV2.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const states = new Array<AgentRun.State>()
      const isUpdated = Schema.is(AgentRun.Event.Updated.data)
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type !== AgentRun.Event.Updated.type || !isUpdated(event.data)) return
          if (event.data.info.id === result.metadata.runId) states.push(event.data.info.state)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
      expect(states).toContainEqual({ type: "cancelled" })
      expect(states.some((state) => state.type === "interrupted")).toBe(false)
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const events = yield* EventV2.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const states = new Array<AgentRun.State>()
      const isUpdated = Schema.is(AgentRun.Event.Updated.data)
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type !== AgentRun.Event.Updated.type || !isUpdated(event.data)) return
          if (event.data.info.id === result.metadata.runId) states.push(event.data.info.state)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
      expect(states).toContainEqual({ type: "cancelled" })
      expect(states.some((state) => state.type === "interrupted")).toBe(false)
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling a parent marks running and queued resumptions cancelled", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never), Effect.as(reply(input, ""))),
      }
      const context = (callID: string) => ({
        sessionID: chat.id,
        messageID: assistant.id,
        callID,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      const first = yield* def.execute(
        {
          description: "inspect cancellation",
          prompt: "start running",
          subagent_type: "general",
          background: true,
        },
        context("call_cancel_first"),
      )
      yield* Deferred.await(ready)
      const second = yield* def.execute(
        {
          description: "queue cancellation",
          prompt: "wait in queue",
          subagent_type: "general",
          task_id: first.metadata.sessionId,
          background: true,
        },
        context("call_cancel_second"),
      )
      expect((yield* runs.get(second.metadata.runId))?.time.started).toBeUndefined()

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(taskJobID(first)))?.status).toBe("cancelled")
      expect((yield* runs.get(first.metadata.runId))?.state).toEqual({ type: "cancelled" })
      expect((yield* runs.get(second.metadata.runId))?.state).toEqual({ type: "cancelled" })
      expect((yield* runs.get(second.metadata.runId))?.time.started).toBeUndefined()
    }),
  )

  background.instance("cancelling the child session marks its active run cancelled", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runs = yield* AgentRun.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()

      const result = yield* def.execute(
        {
          description: "cancel child",
          prompt: "wait for child cancellation",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call_cancel_child",
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never), Effect.as(reply(input, ""))),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      yield* Deferred.await(ready)

      yield* runState.cancel(result.metadata.sessionId)

      expect((yield* jobs.get(taskJobID(result)))?.status).toBe("cancelled")
      expect((yield* runs.get(result.metadata.runId))?.state).toEqual({ type: "cancelled" })
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
