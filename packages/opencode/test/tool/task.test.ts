import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { AgentRun } from "@opencode-ai/core/agent-run"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { AgentRunRuntime } from "@/session/agent-run-runtime"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Provider } from "@/provider/provider"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { ProviderTest } from "../fake/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}
const testProvider = ProviderTest.fake({
  model: ProviderTest.model({ id: ref.modelID, providerID: ref.providerID }),
})

const taskNode = LayerNode.group([
  Agent.node,
  BackgroundJob.node,
  EventV2Bridge.node,
  EventV2.node,
  Config.node,
  CrossSpawnSpawner.node,
  Session.node,
  SessionProjector.node,
  SessionRunState.node,
  SessionStatus.node,
  AgentRun.node,
  AgentRunRuntime.node,
  Truncate.node,
  ToolRegistry.node,
  Database.node,
  RuntimeFlags.node,
  Provider.node,
  Ripgrep.node,
])

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(taskNode, [
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
    [Provider.node, testProvider.layer],
  ])

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
const schedulingFailure = testEffect(
  LayerNode.compile(taskNode, [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalBackgroundSubagents: true })],
    [Provider.node, testProvider.layer],
    [
      BackgroundJob.node,
      Layer.mock(BackgroundJob.Service, {
        extend: () => Effect.succeed(false),
        start: () => Effect.die(new Error("scheduler unavailable")),
        cancel: () => Effect.succeed(undefined),
      }),
    ],
  ]),
)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, user, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}

function taskJobID(result: { metadata: { jobId?: string } }) {
  if (!result.metadata.jobId) throw new Error("task job ID not found")
  return result.metadata.jobId
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute surfaces child errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "",
                error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      expect(child).toBeDefined()
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(`Subagent failed (task_id: ${child?.id}): Network connection lost`)
    }),
  )

  it.instance("execute surfaces terminal child tool errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect external directory",
            prompt: "read the external directory",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "I will inspect the directory.",
                toolError: "The user rejected permission to use this specific tool call.",
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(
        `Subagent failed (task_id: ${child?.id}): The user rejected permission to use this specific tool call.`,
      )
    }),
  )

  it.instance("rejects task_id adoption from another root lineage", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const foreignRoot = yield* sessions.create({ title: "Foreign root" })
      const foreignChild = yield* sessions.create({ parentID: foreignRoot.id, title: "Foreign child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "adopt foreign task",
            prompt: "continue foreign work",
            subagent_type: "general",
            task_id: foreignChild.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: "call_foreign_task",
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                onPrompt: () => {
                  prompted = true
                },
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect((yield* sessions.get(foreignChild.id)).parentID).toBe(foreignRoot.id)
    }),
  )

  it.instance("rejects a caller session parent cycle without hanging", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const runs = yield* AgentRun.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const cycle = yield* sessions.create({ title: "Caller cycle" })
      yield* database.db
        .update(SessionTable)
        .set({ parent_id: cycle.id })
        .where(eq(SessionTable.id, chat.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ parent_id: chat.id })
        .where(eq(SessionTable.id, cycle.id))
        .run()
        .pipe(Effect.orDie)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "call_caller_cycle"

      const exit = yield* def
        .execute(
          {
            description: "reject caller cycle",
            prompt: "do not traverse forever",
            subagent_type: "general",
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
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("caller session parent cycle")
      expect(
        yield* runs.findBySource({
          callerSessionID: chat.id,
          source: { messageID: SessionMessage.ID.make(assistant.id), callID },
        }),
      ).toBeUndefined()
    }),
  )

  it.instance("rejects a task_id session parent cycle without hanging", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const runs = yield* AgentRun.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const first = yield* sessions.create({ parentID: chat.id, title: "First cycle node" })
      const second = yield* sessions.create({ parentID: first.id, title: "Second cycle node" })
      yield* database.db
        .update(SessionTable)
        .set({ parent_id: second.id })
        .where(eq(SessionTable.id, first.id))
        .run()
        .pipe(Effect.orDie)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "call_task_cycle"

      const exit = yield* def
        .execute(
          {
            description: "reject task cycle",
            prompt: "do not traverse forever",
            subagent_type: "general",
            task_id: first.id,
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
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("task_id session parent cycle")
      expect(
        yield* runs.findBySource({
          callerSessionID: chat.id,
          source: { messageID: SessionMessage.ID.make(assistant.id), callID },
        }),
      ).toBeUndefined()
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("rejects missing prompt operations before creating or admitting a task", () =>
    Effect.gen(function* () {
      const runs = yield* AgentRun.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "call_missing_prompt_ops"

      const exit = yield* def
        .execute(
          {
            description: "reject invalid context",
            prompt: "do not admit this task",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect(
        yield* runs.findBySource({
          callerSessionID: chat.id,
          source: { messageID: SessionMessage.ID.make(assistant.id), callID },
        }),
      ).toBeUndefined()
    }),
  )

  it.instance("validates the parent assistant message before creating or admitting a task", () =>
    Effect.gen(function* () {
      const runs = yield* AgentRun.Service
      const sessions = yield* Session.Service
      const { chat, user } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const cases = [
        { messageID: MessageID.ascending(), callID: "call_missing_parent_message" },
        { messageID: user.id, callID: "call_non_assistant_parent_message" },
      ]

      yield* Effect.forEach(
        cases,
        Effect.fnUntraced(function* (input) {
          const exit = yield* def
            .execute(
              {
                description: "reject invalid parent",
                prompt: "do not admit this task",
                subagent_type: "general",
              },
              {
                sessionID: chat.id,
                messageID: input.messageID,
                callID: input.callID,
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
          expect(yield* sessions.children(chat.id)).toHaveLength(0)
          expect(
            yield* runs.findBySource({
              callerSessionID: chat.id,
              source: { messageID: SessionMessage.ID.make(input.messageID), callID: input.callID },
            }),
          ).toBeUndefined()
        }),
        { discard: true },
      )
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("rejects task_id when the session does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: "ses_missing",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: "call_missing_task",
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("rejects a root session as task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "resume root",
            prompt: "do not adopt the root",
            subagent_type: "general",
            task_id: chat.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: "call_root_task",
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
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
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
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

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
      expect(replayed.output).not.toContain("original result")
      expect(replayed.output).not.toContain("<task_result>")
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
