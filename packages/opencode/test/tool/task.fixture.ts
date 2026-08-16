import { AgentRun } from "@opencode-ai/core/agent-run"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { AgentRunRuntime } from "@/session/agent-run-runtime"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

export const ref = {
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

export const it = testEffect(layer())
export const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
export const schedulingFailure = testEffect(
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

export function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
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

export function stubOps(opts?: {
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

export function reply(
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

export function taskJobID(result: { metadata: { jobId?: string } }) {
  if (!result.metadata.jobId) throw new Error("task job ID not found")
  return result.metadata.jobId
}
