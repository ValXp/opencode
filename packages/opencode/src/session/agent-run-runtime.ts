import { AgentRun } from "@opencode-ai/core/agent-run"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Cause, Context, DateTime, Duration, Effect, Exit, Layer, Ref, Schema } from "effect"
import type { Provider } from "@/provider/provider"
import { AgentRunControl } from "./agent-run-control"
import { AgentRunSummary } from "./agent-run-summary"

const isSessionStatus = Schema.is(SessionStatusEvent.Status.data)
const MAX_ERROR_LENGTH = 2_000
const SUMMARY_REFRESH_TIMEOUT = Duration.seconds(10)

export interface ExecuteInput<A, E, R> {
  readonly id: AgentRun.ID
  readonly sessionID: AgentRun.Info["sessionID"]
  readonly model?: Provider.Model
  readonly effect: Effect.Effect<A, E, R>
}

export interface Interface {
  readonly ownerID: string
  readonly admit: (input: Omit<AgentRun.AdmitInput, "ownerID">) => Effect.Effect<AgentRun.Admission>
  readonly findBySource: AgentRun.Interface["findBySource"]
  readonly fail: (id: AgentRun.ID, cause: Cause.Cause<unknown>) => Effect.Effect<void>
  readonly execute: <A, E, R>(input: ExecuteInput<A, E, R>) => Effect.Effect<A, E, R>
  readonly cancelTree: (sessionID: AgentRun.Info["sessionID"]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentRunRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const control = yield* AgentRunControl.Service
    const events = yield* EventV2.Service
    const summaries = yield* AgentRunSummary.Service
    const fail: Interface["fail"] = Effect.fn("AgentRunRuntime.fail")((id, cause) =>
      control.transition({ id, state: { type: "failed", error: failureMessage(cause) } }).pipe(Effect.asVoid),
    )

    const execute: Interface["execute"] = Effect.fn("AgentRunRuntime.execute")(function* (input) {
      const watcher = yield* Ref.make<AgentRunSummary.Watcher | undefined>(undefined)
      const retrying = yield* Ref.make(false)
      return yield* Effect.scoped(
        Effect.acquireUseRelease(
          control.start(input.id),
          (started) => {
            if (!started) return Effect.interrupt
            return Effect.gen(function* () {
              yield* Effect.uninterruptibleMask((restore) =>
                restore(
                  summaries
                    .watch({
                      runID: input.id,
                      childSessionID: input.sessionID,
                      ownerID: control.ownerID,
                      model: input.model,
                    })
                    .pipe(
                      Effect.catchCauseIf(
                        (cause) => !Cause.hasInterrupts(cause),
                        (cause) =>
                          Effect.logWarning("failed to start agent run summary", { cause }).pipe(Effect.as(undefined)),
                      ),
                    ),
                ).pipe(Effect.flatMap((value) => Ref.set(watcher, value))),
              )
              return yield* Effect.acquireUseRelease(
                events.listen((event) => {
                  if (event.type !== SessionStatusEvent.Status.type || !isSessionStatus(event.data)) {
                    return Effect.void
                  }
                  if (event.data.sessionID !== input.sessionID) return Effect.void
                  if (event.data.status.type === "retry") {
                    return Ref.set(retrying, true).pipe(
                      Effect.andThen(
                        control.transition({
                          id: input.id,
                          state: {
                            type: "retrying",
                            attempt: event.data.status.attempt,
                            message: event.data.status.message,
                            next: DateTime.makeUnsafe(event.data.status.next),
                          },
                        }),
                      ),
                      Effect.asVoid,
                    )
                  }
                  if (event.data.status.type !== "busy") return Effect.void
                  return Ref.getAndSet(retrying, false).pipe(
                    Effect.flatMap((active) =>
                      active
                        ? control.transition({ id: input.id, state: { type: "running" } }).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  )
                }),
                () => input.effect,
                (unsubscribe) => unsubscribe,
              )
            })
          },
          (_, exit) =>
            Effect.gen(function* () {
              const activeWatcher = yield* Ref.get(watcher)
              if (activeWatcher) {
                yield* activeWatcher.refresh.pipe(
                  Effect.timeoutOrElse({ duration: SUMMARY_REFRESH_TIMEOUT, orElse: () => Effect.void }),
                  Effect.catchCause((cause) => Effect.logWarning("failed to refresh agent run summary", { cause })),
                )
              }
              yield* control.transition({
                id: input.id,
                state: Exit.isSuccess(exit)
                  ? { type: "succeeded" }
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? { type: "interrupted", reason: "execution_interrupted" }
                    : { type: "failed", error: failureMessage(exit.cause) },
              })
            }),
        ),
      )
    })

    return Service.of({
      ownerID: control.ownerID,
      admit: control.admit,
      findBySource: control.findBySource,
      fail,
      execute,
      cancelTree: control.cancelTree,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AgentRunControl.node, EventV2.node, AgentRunSummary.node],
})

function failureMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Task failed"
  return (message.trim() || "Task failed").slice(0, MAX_ERROR_LENGTH)
}

export * as AgentRunRuntime from "./agent-run-runtime"
