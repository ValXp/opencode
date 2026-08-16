import { AgentRun } from "@opencode-ai/core/agent-run"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { Context, Duration, Effect, Layer, Ref, Scope, Semaphore, Stream } from "effect"
import { Agent } from "@/agent/agent"
import PROMPT_ACTIVITY_STATUS from "@/agent/prompt/activity-status.txt"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"

const MAX_SUMMARY_LENGTH = 80
const MAX_ACTIVITY_LENGTH = 4_000
const MAX_ACTIVITY_PARTS = 24
const MAX_ACTIVITY_PART_LENGTH = 500
const MODEL_TIMEOUT = Duration.seconds(5)
const FINAL_REFRESH_TIMEOUT = Duration.seconds(10)

export interface Input {
  readonly runID: AgentRun.ID
  readonly childSessionID: SessionID
  readonly ownerID: string
  readonly model?: Provider.Model
}

export interface Watcher {
  readonly refresh: Effect.Effect<void>
}

export interface ObserveInterface {
  readonly revision: (childSessionID: SessionID) => Effect.Effect<number>
  readonly recent: (childSessionID: SessionID) => Effect.Effect<SessionV1.WithParts[]>
}

export class Observe extends Context.Service<Observe, ObserveInterface>()("@opencode/AgentRunSummary/Observe") {}

export const observeLayer = Layer.effect(
  Observe,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    return Observe.of({
      revision: (childSessionID) => EventV2.latestSequence(database.db, childSessionID),
      recent: (childSessionID) => sessions.messages({ sessionID: childSessionID, limit: 8 }).pipe(Effect.orDie),
    })
  }),
)

export interface GenerateInput {
  readonly childSessionID: SessionID
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly user: SessionV1.User
  readonly activity: string
}

export interface GenerateInterface {
  readonly generate: (input: GenerateInput) => Effect.Effect<string, unknown>
}

export class Generate extends Context.Service<Generate, GenerateInterface>()("@opencode/AgentRunSummary/Generate") {}

export const generateLayer = Layer.effect(
  Generate,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    return Generate.of({
      generate: Effect.fn("AgentRunSummary.Generate.generate")((input: GenerateInput) =>
        llm
          .stream({
            user: {
              ...input.user,
              system: undefined,
              tools: {},
              model: { providerID: input.model.providerID, modelID: input.model.id },
            },
            sessionID: input.childSessionID,
            model: input.model,
            agent: input.agent,
            system: [],
            messages: [{ role: "user", content: input.activity }],
            small: true,
            tools: {},
            retries: 0,
            toolChoice: "none",
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((event) => event.text),
            Stream.mkString,
          ),
      ),
    })
  }),
)

export interface Interface {
  readonly watch: (input: Input) => Effect.Effect<Watcher, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentRunSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runs = yield* AgentRun.Service
    const observe = yield* Observe
    const generate = yield* Generate
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service
    const modelCalls = Semaphore.makeUnsafe(2)

    const watch = Effect.fn("AgentRunSummary.watch")(function* (input: Input) {
      const lastRevision = yield* Ref.make(yield* observe.revision(input.childSessionID))
      const lock = Semaphore.makeUnsafe(1)
      const refresh = lock
        .withPermit(
          Effect.gen(function* () {
            const revision = yield* observe.revision(input.childSessionID)
            if (revision === (yield* Ref.get(lastRevision))) return
            yield* Ref.set(lastRevision, revision)

            const capture = yield* runs.touch({ id: input.runID, ownerID: input.ownerID })
            if (!capture) return
            const messages = yield* observe.recent(input.childSessionID)
            const title = yield* agents
              .get("title")
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to load title agent for run summary", { cause }).pipe(Effect.as(undefined)),
                ),
              )
            const model = flags.agentRunModelSummaries
              ? yield* Effect.gen(function* () {
                  if (title?.model) return yield* provider.getModel(title.model.providerID, title.model.modelID)
                  if (!input.model) return
                  return (yield* provider.getSmallModel(input.model.providerID)) ?? input.model
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to resolve agent run summary model", { cause }).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                )
              : undefined
            const user = messages.findLast(
              (message): message is SessionV1.WithParts & { info: SessionV1.User } => message.info.role === "user",
            )?.info
            const generated =
              model && user
                ? yield* modelCalls
                    .withPermit(
                      generate.generate({
                        childSessionID: input.childSessionID,
                        model,
                        agent: activityAgent(title),
                        user,
                        activity: activityContext(messages, capture.info.description),
                      }),
                    )
                    .pipe(
                      Effect.map(normalizeSummary),
                      Effect.timeoutOrElse({ duration: MODEL_TIMEOUT, orElse: () => Effect.succeed(undefined) }),
                      Effect.catchCause((cause) =>
                        Effect.logWarning("failed to generate agent run summary", { cause }).pipe(Effect.as(undefined)),
                      ),
                    )
                : undefined
            const summary = generated ?? fallbackSummary(messages, capture.info.description)
            yield* runs.summarize({
              id: input.runID,
              ownerID: input.ownerID,
              revision: capture.revision,
              summary,
            })
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to summarize agent run activity", { cause }))),
        )
        .pipe(Effect.timeoutOrElse({ duration: FINAL_REFRESH_TIMEOUT, orElse: () => Effect.void }))

      yield* Effect.sleep(Duration.seconds(30)).pipe(
        Effect.andThen(refresh),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
      return { refresh }
    })

    return Service.of({ watch })
  }),
)

export const live = layer.pipe(Layer.provide(Layer.mergeAll(observeLayer, generateLayer)))

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [AgentRun.node, Database.node, Agent.node, Provider.node, LLM.node, RuntimeFlags.node, Session.node],
})

function normalizeSummary(output: string) {
  const line = output
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return
  const clean = line.replace(/\s+/g, " ")
  if (clean.length <= MAX_SUMMARY_LENGTH) return clean
  return clean.slice(0, MAX_SUMMARY_LENGTH - 3).trimEnd() + "..."
}

function fallbackSummary(messages: SessionV1.WithParts[], description: string) {
  const part = messages
    .flatMap((message) => message.parts)
    .toReversed()
    .map(fallbackPart)
    .find((item): item is string => item !== undefined)
  return normalizeSummary(part ?? `Working on ${description}`) ?? "Working"
}

function fallbackPart(part: SessionV1.Part) {
  if (part.type === "tool") {
    const title = "title" in part.state ? part.state.title : undefined
    if (title) return normalizeSummary(title)
    const tool = part.tool.replaceAll("_", " ")
    if (part.state.status === "pending") return `Preparing ${tool}`
    if (part.state.status === "running") return `Using ${tool}`
    if (part.state.status === "completed") return `Completed ${tool}`
    return `Checking ${tool} failure`
  }
  if (part.type === "subtask") return normalizeSummary(`Working on ${part.description}`)
  if (part.type === "retry") return "Retrying model request"
  if (part.type === "patch") return `Updating ${part.files.length} ${part.files.length === 1 ? "file" : "files"}`
  if (part.type === "step-start") return "Continuing agent work"
  if (part.type === "step-finish") return "Completing agent turn"
  if (part.type === "agent") return normalizeSummary(`Switching to ${part.name}`)
  if (part.type === "file") return normalizeSummary(`Reviewing ${part.filename ?? "attachment"}`)
}

function activityAgent(title: Agent.Info | undefined): Agent.Info {
  return {
    ...(title ?? { name: "title", mode: "primary", permission: [], options: {} }),
    name: "title",
    mode: "primary",
    hidden: true,
    permission: [],
    prompt: PROMPT_ACTIVITY_STATUS,
  }
}

function activityContext(messages: SessionV1.WithParts[], description: string) {
  const facts = messages
    .flatMap((message) => message.parts.map((part) => activityPart(message.info.role, part)))
    .filter((fact): fact is string => fact !== undefined)
    .slice(-MAX_ACTIVITY_PARTS)
  const activity = [`Run description: ${activityFact(description)}`, ...facts].join("\n")
  if (activity.length <= MAX_ACTIVITY_LENGTH) return activity
  return activity.slice(activity.length - MAX_ACTIVITY_LENGTH)
}

function activityPart(role: SessionV1.Info["role"], part: SessionV1.Part) {
  if (part.type === "reasoning" || part.type === "snapshot") return
  if (part.type === "text") {
    if (part.synthetic || part.ignored || !part.text.trim()) return
    return `${role === "user" ? "Request" : "Response"}: ${activityFact(part.text)}`
  }
  if (part.type === "tool") {
    const title = "title" in part.state ? part.state.title : undefined
    return [
      `Tool activity: ${activityFact(part.tool.replaceAll("_", " "))}`,
      `state ${part.state.status}`,
      title ? `title ${activityFact(title)}` : undefined,
    ]
      .filter((fact): fact is string => fact !== undefined)
      .join("; ")
  }
  if (part.type === "subtask") return `Subtask: ${activityFact(part.description)}`
  if (part.type === "retry") return "State: retrying model request"
  if (part.type === "patch") return `State: updated ${part.files.length} ${part.files.length === 1 ? "file" : "files"}`
  if (part.type === "step-start") return "State: started a provider turn"
  if (part.type === "step-finish") return `State: finished a provider turn (${activityFact(part.reason)})`
  if (part.type === "agent") return `State: switched to ${activityFact(part.name)}`
  if (part.type === "file") return `Attachment: ${activityFact(part.filename ?? part.mime)}`
  if (part.type === "compaction") return "State: compacting context"
}

function activityFact(value: string) {
  const line = value.replace(/\s+/g, " ").trim()
  if (line.length <= MAX_ACTIVITY_PART_LENGTH) return line
  return line.slice(0, MAX_ACTIVITY_PART_LENGTH - 3).trimEnd() + "..."
}

export * as AgentRunSummary from "./agent-run-summary"
