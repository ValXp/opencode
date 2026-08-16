import { describe, expect } from "bun:test"
import { AgentRun } from "@opencode-ai/core/agent-run"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LLMEvent } from "@opencode-ai/llm"
import { DateTime, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { AgentRunSummary } from "@/session/agent-run-summary"
import { LLM } from "@/session/llm"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ProviderTest } from "../fake/provider"
import { it } from "../lib/effect"

const runID = AgentRun.ID.make("arun_summary_test")
const childSessionID = SessionID.make("ses_summary_child")
const ownerID = "summary-owner"
const model = ProviderTest.model({
  id: ModelV2.ID.make("run-model"),
  providerID: ProviderV2.ID.make("run-provider"),
})
const info = AgentRun.Info.make({
  id: runID,
  sessionID: childSessionID,
  callerSessionID: SessionID.make("ses_summary_parent"),
  source: { messageID: SessionMessage.ID.make("msg_summary_source"), callID: "call_summary" },
  agent: AgentV2.ID.make("general"),
  description: "Trace session events",
  background: true,
  state: { type: "running" },
  activity: { at: DateTime.makeUnsafe(0) },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  version: 0,
})
const messageID = MessageID.make("msg_summary_user")
const recent = [
  {
    info: {
      id: messageID,
      sessionID: childSessionID,
      role: "user" as const,
      time: { created: 0 },
      agent: "general",
      model: { providerID: model.providerID, modelID: model.id },
    },
    parts: [
      {
        id: PartID.make("prt_summary_user"),
        sessionID: childSessionID,
        messageID,
        type: "text" as const,
        text: "Trace session events",
      },
    ],
  },
]

function makeLayer(input: {
  revision: AgentRunSummary.ObserveInterface["revision"]
  generate: AgentRunSummary.GenerateInterface["generate"]
  summarize: AgentRun.Interface["summarize"]
  recent?: AgentRunSummary.ObserveInterface["recent"]
  touch?: AgentRun.Interface["touch"]
  getAgent?: Agent.Interface["get"]
  getModel?: Provider.Interface["getModel"]
  getSmallModel?: Provider.Interface["getSmallModel"]
  modelSummaries?: boolean
}) {
  return AgentRunSummary.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AgentRunSummary.Observe,
          AgentRunSummary.Observe.of({
            revision: input.revision,
            recent: input.recent ?? (() => Effect.succeed(recent)),
          }),
        ),
        Layer.succeed(
          AgentRunSummary.Generate,
          AgentRunSummary.Generate.of({
            generate: input.generate,
          }),
        ),
        Layer.mock(AgentRun.Service, {
          touch: input.touch ?? (() => Effect.succeed({ info, revision: 1 })),
          summarize: input.summarize,
        }),
        Layer.mock(Agent.Service, {
          get:
            input.getAgent ??
            (() =>
              Effect.succeed({
                name: "title",
                mode: "primary",
                hidden: true,
                permission: [],
                options: {},
              })),
        }),
        Layer.mock(Provider.Service, {
          getModel: input.getModel ?? (() => Effect.succeed(model)),
          getSmallModel: input.getSmallModel ?? (() => Effect.succeed(model)),
        }),
        RuntimeFlags.layer({ agentRunModelSummaries: input.modelSummaries ?? true }),
      ),
    ),
  )
}

describe("AgentRunSummary", () => {
  it.effect("waits 30 seconds before summarizing changed child activity", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const generated = yield* Ref.make(0)
      const summaries = yield* Ref.make<string[]>([])
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        generate: () => Ref.update(generated, (count) => count + 1).pipe(Effect.as("Tracing session events")),
        summarize: (input) => Ref.update(summaries, (values) => [...values, input.summary]).pipe(Effect.as(info)),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        yield* service.watch({ runID, childSessionID, ownerID, model })

        yield* TestClock.adjust("29 seconds")
        expect(yield* Ref.get(generated)).toBe(0)
        expect(yield* Ref.get(summaries)).toEqual([])

        yield* Ref.set(revision, 1)
        yield* TestClock.adjust("1 second")
        expect(yield* Ref.get(generated)).toBe(1)
        expect(yield* Ref.get(summaries)).toEqual(["Tracing session events"])
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("prefers the title model, then the small model, then the run model", () =>
    Effect.gen(function* () {
      const explicit = ProviderTest.model({
        id: ModelV2.ID.make("title-model"),
        providerID: ProviderV2.ID.make("title-provider"),
      })
      const small = ProviderTest.model({
        id: ModelV2.ID.make("small-model"),
        providerID: model.providerID,
      })
      const selected = yield* Ref.make<string[]>([])

      const select = (input: { title?: Provider.Model; small?: Provider.Model }) =>
        Effect.gen(function* () {
          const revision = yield* Ref.make(0)
          const layer = makeLayer({
            revision: () => Ref.get(revision),
            generate: (request) =>
              Ref.update(selected, (values) => [...values, request.model.id]).pipe(Effect.as("Tracing session events")),
            summarize: () => Effect.succeed(info),
            getAgent: () =>
              Effect.succeed({
                name: "title",
                mode: "primary",
                hidden: true,
                permission: [],
                options: {},
                model: input.title ? { providerID: input.title.providerID, modelID: input.title.id } : undefined,
              }),
            getModel: () => Effect.succeed(explicit),
            getSmallModel: () => Effect.succeed(input.small),
          })

          yield* Effect.gen(function* () {
            const service = yield* AgentRunSummary.Service
            const watcher = yield* service.watch({ runID, childSessionID, ownerID, model })
            yield* Ref.set(revision, 1)
            yield* watcher.refresh
          }).pipe(Effect.provide(layer))
        })

      yield* select({ title: explicit, small })
      yield* select({ small })
      yield* select({})

      expect(yield* Ref.get(selected)).toEqual(["title-model", "small-model", "run-model"])
    }),
  )

  it.effect("persists one bounded line from model output", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const summaries = yield* Ref.make<string[]>([])
      const line = `Tracing ${"session events ".repeat(10)}`
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        generate: () => Effect.succeed(`<think>private reasoning</think>\n\n${line}\nextra line`),
        summarize: (input) => Ref.update(summaries, (values) => [...values, input.summary]).pipe(Effect.as(info)),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        const watcher = yield* service.watch({ runID, childSessionID, ownerID, model })
        yield* Ref.set(revision, 1)
        yield* watcher.refresh
      }).pipe(Effect.provide(layer))

      const summary = (yield* Ref.get(summaries))[0]
      expect(summary).toBeDefined()
      expect(summary).not.toContain("\n")
      expect(summary?.length).toBe(80)
      expect(summary?.startsWith("Tracing session events")).toBe(true)
      expect(summary?.endsWith("...")).toBe(true)
    }),
  )

  it.effect("persists a deterministic safe fallback without a model or after inference failure", () =>
    Effect.gen(function* () {
      const summaries = yield* Ref.make<string[]>([])
      const toolRecent = [
        {
          ...recent[0],
          parts: [
            {
              id: PartID.make("prt_summary_tool"),
              sessionID: childSessionID,
              messageID,
              type: "tool" as const,
              callID: "call_tool",
              tool: "grep",
              state: {
                status: "running" as const,
                input: {},
                title: "Tracing durable session events",
                time: { start: 0 },
              },
            },
          ],
        },
      ]

      const run = (withModel: boolean) =>
        Effect.gen(function* () {
          const revision = yield* Ref.make(0)
          const layer = makeLayer({
            revision: () => Ref.get(revision),
            recent: () => Effect.succeed(toolRecent),
            generate: () =>
              withModel
                ? Effect.fail(new Error("inference unavailable"))
                : Effect.die(new Error("generation must not run without a model")),
            summarize: (input) => Ref.update(summaries, (values) => [...values, input.summary]).pipe(Effect.as(info)),
            getSmallModel: () => Effect.succeed(undefined),
          })

          yield* Effect.gen(function* () {
            const service = yield* AgentRunSummary.Service
            const watcher = yield* service.watch({
              runID,
              childSessionID,
              ownerID,
              model: withModel ? model : undefined,
            })
            yield* Ref.set(revision, 1)
            yield* watcher.refresh
          }).pipe(Effect.provide(layer))
        })

      yield* run(false)
      yield* run(true)

      expect(yield* Ref.get(summaries)).toEqual(["Tracing durable session events", "Tracing durable session events"])
    }),
  )

  it.effect("uses local fallback summaries unless model summaries are explicitly enabled", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const summaries = yield* Ref.make<string[]>([])
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        generate: () => Effect.die(new Error("model generation must remain disabled")),
        summarize: (input) => Ref.update(summaries, (values) => [...values, input.summary]).pipe(Effect.as(info)),
        modelSummaries: false,
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        const watcher = yield* service.watch({ runID, childSessionID, ownerID, model })
        yield* Ref.set(revision, 1)
        yield* watcher.refresh
      }).pipe(Effect.provide(layer))

      expect(yield* Ref.get(summaries)).toEqual(["Working on Trace session events"])
    }),
  )

  it.effect("generates from bounded safe activity facts with a dedicated status prompt", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const requests = yield* Ref.make<Array<{ activity: string; prompt: string | undefined }>>([])
      const context = [
        {
          ...recent[0],
          parts: [
            {
              id: PartID.make("prt_summary_reasoning"),
              sessionID: childSessionID,
              messageID,
              type: "reasoning" as const,
              text: "SECRET_CHAIN_OF_THOUGHT",
              time: { start: 0 },
            },
            {
              id: PartID.make("prt_summary_long_text"),
              sessionID: childSessionID,
              messageID,
              type: "text" as const,
              text: "Inspect durable activity " + "x".repeat(8_000),
            },
            {
              id: PartID.make("prt_summary_completed_tool"),
              sessionID: childSessionID,
              messageID,
              type: "tool" as const,
              callID: "call_completed_tool",
              tool: "grep",
              state: {
                status: "completed" as const,
                input: {},
                output: "SECRET_TOOL_OUTPUT",
                title: "Located session event revisions",
                metadata: {},
                time: { start: 0, end: 1 },
              },
            },
          ],
        },
      ]
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        recent: () => Effect.succeed(context),
        generate: (request) =>
          Ref.update(requests, (values) => [
            ...values,
            { activity: request.activity, prompt: request.agent.prompt },
          ]).pipe(Effect.as("Tracing session events")),
        summarize: () => Effect.succeed(info),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        const watcher = yield* service.watch({ runID, childSessionID, ownerID, model })
        yield* Ref.set(revision, 1)
        yield* watcher.refresh
      }).pipe(Effect.provide(layer))

      const request = (yield* Ref.get(requests))[0]
      expect(request).toBeDefined()
      expect(request?.activity.length).toBeLessThanOrEqual(4_000)
      expect(request?.activity).toContain("Located session event revisions")
      expect(request?.activity).not.toContain("SECRET_CHAIN_OF_THOUGHT")
      expect(request?.activity).not.toContain("SECRET_TOOL_OUTPUT")
      expect(request?.prompt).toContain("semantic activity status")
    }),
  )

  it.effect("calls LLM directly with no tools and only in-memory status context", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<LLM.StreamInput[]>([])
      const layer = AgentRunSummary.generateLayer.pipe(
        Layer.provide(
          Layer.succeed(
            LLM.Service,
            LLM.Service.of({
              stream: (input) =>
                Stream.fromEffect(Ref.update(calls, (values) => [...values, input])).pipe(
                  Stream.flatMap(() =>
                    Stream.make(
                      LLMEvent.textDelta({ id: "status", text: "Tracing " }),
                      LLMEvent.textDelta({ id: "status", text: "session events" }),
                    ),
                  ),
                ),
            }),
          ),
        ),
      )

      const output = yield* Effect.gen(function* () {
        const generate = yield* AgentRunSummary.Generate
        return yield* generate.generate({
          childSessionID,
          model,
          agent: {
            name: "title",
            mode: "primary",
            hidden: true,
            permission: [],
            options: {},
            prompt: "Dedicated activity prompt",
          },
          user: recent[0].info,
          activity: "Run description: Trace session events",
        })
      }).pipe(Effect.provide(layer))

      expect(output).toBe("Tracing session events")
      const call = (yield* Ref.get(calls))[0]
      expect(call?.tools).toEqual({})
      expect(call?.toolChoice).toBe("none")
      expect(call?.messages).toEqual([{ role: "user", content: "Run description: Trace session events" }])
      expect(call?.small).toBe(true)
    }),
  )

  it.effect("bounds concurrent model calls to two", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const active = yield* Ref.make(0)
      const maximum = yield* Ref.make(0)
      const calls = yield* Ref.make(0)
      const twoStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        generate: () =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(active, (value) => value + 1)
            yield* Ref.update(maximum, (value) => Math.max(value, count))
            yield* Ref.update(calls, (value) => value + 1)
            if (count === 2) yield* Deferred.succeed(twoStarted, undefined).pipe(Effect.ignore)
            yield* Deferred.await(release)
            return "Tracing session events"
          }).pipe(Effect.ensuring(Ref.update(active, (value) => value - 1))),
        summarize: () => Effect.succeed(info),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        const watchers = yield* Effect.all(
          [0, 1, 2].map(() => service.watch({ runID, childSessionID, ownerID, model })),
          { concurrency: "unbounded" },
        )
        yield* Ref.set(revision, 1)
        const refresh = yield* Effect.all(
          watchers.map((watcher) => watcher.refresh),
          {
            concurrency: "unbounded",
          },
        ).pipe(Effect.forkScoped({ startImmediately: true }))

        yield* Deferred.await(twoStarted)
        yield* Effect.yieldNow
        expect(yield* Ref.get(active)).toBe(2)
        expect(yield* Ref.get(maximum)).toBe(2)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.await(refresh)
        expect(yield* Ref.get(calls)).toBe(3)
        expect(yield* Ref.get(maximum)).toBe(2)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("finishes a final refresh with fallback when inference does not return", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const summaries = yield* Ref.make<string[]>([])
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        generate: () => Effect.never,
        summarize: (input) => Ref.update(summaries, (values) => [...values, input.summary]).pipe(Effect.as(info)),
        recent: () => Effect.succeed(recent),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        const watcher = yield* service.watch({ runID, childSessionID, ownerID, model })
        yield* Ref.set(revision, 1)
        const refresh = yield* watcher.refresh.pipe(Effect.forkScoped({ startImmediately: true }))

        yield* TestClock.adjust("5 seconds")

        expect(refresh.pollUnsafe()).toBeDefined()
        expect(yield* Ref.get(summaries)).toEqual(["Working on Trace session events"])
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("observes the durable child revision and a bounded recent message window", () =>
    Effect.gen(function* () {
      const requested = yield* Ref.make<Array<{ sessionID: SessionID; limit?: number }>>([])
      const layer = AgentRunSummary.observeLayer.pipe(
        Layer.provide(
          Layer.mock(Session.Service, {
            messages: (input) => Ref.update(requested, (values) => [...values, input]).pipe(Effect.as(recent)),
          }),
        ),
        Layer.provideMerge(Database.layerFromPath(":memory:")),
      )

      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db
          .insert(EventSequenceTable)
          .values({ aggregate_id: childSessionID, seq: 7 })
          .run()
          .pipe(Effect.orDie)

        const observe = yield* AgentRunSummary.Observe
        expect(yield* observe.revision(childSessionID)).toBe(7)
        expect(yield* observe.recent(childSessionID)).toEqual(recent)
        expect(yield* Ref.get(requested)).toEqual([{ sessionID: childSessionID, limit: 8 }])
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("skips unchanged activity and refreshes once for the next child revision", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const generated = yield* Ref.make(0)
      const recentReads = yield* Ref.make(0)
      const touches = yield* Ref.make(0)
      const summaries = yield* Ref.make(0)
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        recent: () => Ref.update(recentReads, (value) => value + 1).pipe(Effect.as(recent)),
        generate: () => Ref.update(generated, (value) => value + 1).pipe(Effect.as("Tracing session events")),
        touch: () =>
          Ref.updateAndGet(touches, (value) => value + 1).pipe(
            Effect.map((activityRevision) => ({ info, revision: activityRevision })),
          ),
        summarize: () => Ref.update(summaries, (value) => value + 1).pipe(Effect.as(info)),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        yield* service.watch({ runID, childSessionID, ownerID, model })

        yield* Ref.set(revision, 1)
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("30 seconds")

        expect(yield* Ref.get(generated)).toBe(1)
        expect(yield* Ref.get(recentReads)).toBe(1)
        expect(yield* Ref.get(touches)).toBe(1)
        expect(yield* Ref.get(summaries)).toBe(1)

        yield* Ref.set(revision, 2)
        yield* TestClock.adjust("30 seconds")

        expect(yield* Ref.get(generated)).toBe(2)
        expect(yield* Ref.get(recentReads)).toBe(2)
        expect(yield* Ref.get(touches)).toBe(2)
        expect(yield* Ref.get(summaries)).toBe(2)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("honors Core compare-and-set rejection for a stale activity revision", () =>
    Effect.gen(function* () {
      const childRevision = yield* Ref.make(0)
      const activityRevision = yield* Ref.make(1)
      const generated = yield* Ref.make(0)
      const submitted = yield* Ref.make<number[]>([])
      const persisted = yield* Ref.make<string[]>([])
      const layer = makeLayer({
        revision: () => Ref.get(childRevision),
        touch: () => Ref.get(activityRevision).pipe(Effect.map((revision) => ({ info, revision }))),
        generate: () =>
          Ref.update(generated, (value) => value + 1).pipe(
            Effect.andThen(Ref.set(activityRevision, 2)),
            Effect.as("Tracing session events"),
          ),
        summarize: (input) =>
          Ref.update(submitted, (values) => [...values, input.revision]).pipe(
            Effect.andThen(Ref.get(activityRevision)),
            Effect.flatMap((revision) =>
              revision === input.revision
                ? Ref.update(persisted, (values) => [...values, input.summary]).pipe(Effect.as(info))
                : Effect.succeed(undefined),
            ),
          ),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        const watcher = yield* service.watch({ runID, childSessionID, ownerID, model })
        yield* Ref.set(childRevision, 1)
        yield* watcher.refresh
        yield* watcher.refresh
      }).pipe(Effect.provide(layer))

      expect(yield* Ref.get(submitted)).toEqual([1])
      expect(yield* Ref.get(persisted)).toEqual([])
      expect(yield* Ref.get(generated)).toBe(1)
    }),
  )

  it.effect("stops observing when the watcher scope closes", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const observations = yield* Ref.make(0)
      const generated = yield* Ref.make(0)
      const layer = makeLayer({
        revision: () => Ref.update(observations, (value) => value + 1).pipe(Effect.andThen(Ref.get(revision))),
        generate: () => Ref.update(generated, (value) => value + 1).pipe(Effect.as("Tracing session events")),
        summarize: () => Effect.succeed(info),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        yield* service.watch({ runID, childSessionID, ownerID, model }).pipe(Effect.scoped)
        yield* Ref.set(revision, 1)
        yield* TestClock.adjust("60 seconds")

        expect(yield* Ref.get(observations)).toBe(1)
        expect(yield* Ref.get(generated)).toBe(0)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("bounds the whole final refresh when activity loading stalls", () =>
    Effect.gen(function* () {
      const revision = yield* Ref.make(0)
      const layer = makeLayer({
        revision: () => Ref.get(revision),
        recent: () => Effect.never,
        generate: () => Effect.succeed("Tracing session events"),
        summarize: () => Effect.succeed(info),
      })

      yield* Effect.gen(function* () {
        const service = yield* AgentRunSummary.Service
        const watcher = yield* service.watch({ runID, childSessionID, ownerID, model })
        yield* Ref.set(revision, 1)
        const refresh = yield* watcher.refresh.pipe(Effect.forkScoped({ startImmediately: true }))

        yield* TestClock.adjust("10 seconds")

        expect(refresh.pollUnsafe()).toBeDefined()
      }).pipe(Effect.provide(layer))
    }),
  )
})
