import { AgentRun } from "@opencode-ai/core/agent-run"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Identifier } from "@opencode-ai/core/id/id"
import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly ownerID: string
  readonly admit: (input: Omit<AgentRun.AdmitInput, "ownerID">) => Effect.Effect<AgentRun.Admission>
  readonly findBySource: AgentRun.Interface["findBySource"]
  readonly start: (id: AgentRun.ID) => Effect.Effect<AgentRun.Info | undefined>
  readonly transition: (input: { id: AgentRun.ID; state: AgentRun.State }) => Effect.Effect<AgentRun.Info | undefined>
  readonly cancelTree: (sessionID: AgentRun.Info["sessionID"]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentRunControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runs = yield* AgentRun.Service
    const ownerID = Identifier.create("agent-run-owner", "ascending")
    const active = new Set<AgentRun.ID>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        active,
        (id) => runs.transition({ id, ownerID, state: { type: "interrupted", reason: "runtime_shutdown" } }),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.ensuring(Effect.sync(() => active.clear()))),
    )

    const admit: Interface["admit"] = Effect.fn("AgentRunControl.admit")(function* (input) {
      return yield* Effect.uninterruptible(
        runs.admit({ ...input, ownerID }).pipe(
          Effect.tap((admission) =>
            Effect.sync(() => {
              if (admission.info.state.type === "running" || admission.info.state.type === "retrying") {
                active.add(admission.info.id)
              }
            }),
          ),
        ),
      )
    })

    const start: Interface["start"] = Effect.fn("AgentRunControl.start")((id) => runs.start({ id, ownerID }))

    const transition: Interface["transition"] = Effect.fn("AgentRunControl.transition")((input) =>
      runs
        .transition({ ...input, ownerID })
        .pipe(
          Effect.ensuring(
            input.state.type === "running" || input.state.type === "retrying"
              ? Effect.void
              : Effect.sync(() => active.delete(input.id)),
          ),
        ),
    )

    const cancelTree: Interface["cancelTree"] = Effect.fn("AgentRunControl.cancelTree")(function* (sessionID) {
      const snapshot = yield* runs.snapshot(sessionID)
      yield* Effect.forEach(snapshot.active, (run) => transition({ id: run.id, state: { type: "cancelled" } }), {
        concurrency: "unbounded",
        discard: true,
      })
    })

    return Service.of({ ownerID, admit, findBySource: runs.findBySource, start, transition, cancelTree })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AgentRun.node] })

export * as AgentRunControl from "./agent-run-control"
