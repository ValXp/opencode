import { describe, expect, test } from "bun:test"
import { DateTime, Schema, SchemaAST } from "effect"
import { Agent, AgentRun, Session, SessionMessage } from "../src"
import { EventManifest } from "../src/event-manifest"

describe("AgentRun", () => {
  test("creates and validates IDs with the exact arun_ prefix", () => {
    expect(AgentRun.ID.create()).toStartWith("arun_")
    expect(Schema.decodeUnknownSync(AgentRun.ID)("arun_test")).toBe(AgentRun.ID.make("arun_test"))
    expect(() => Schema.decodeUnknownSync(AgentRun.ID)("arunX_test")).toThrow()
  })

  test("decodes every lifecycle state and rejects unknown fallback reasons", () => {
    const states = [
      { type: "running" },
      { type: "retrying", attempt: 2, message: "rate limited", next: 1_000 },
      { type: "succeeded" },
      { type: "failed", error: "provider failed" },
      { type: "cancelled" },
      { type: "interrupted", reason: "process stopped" },
      { type: "unknown", reason: "owner_lost" },
      { type: "unknown", reason: "legacy_ambiguous" },
      { type: "unknown", reason: "orphaned" },
    ] as const

    expect(states.map((state) => Schema.decodeUnknownSync(AgentRun.State)(state).type)).toEqual(
      states.map((state) => state.type),
    )
    expect(() => Schema.decodeUnknownSync(AgentRun.State)({ type: "unknown", reason: "other" })).toThrow()
  })

  test("encodes Info with canonical dates and omits undefined optional fields", () => {
    const info = AgentRun.Info.make({
      id: AgentRun.ID.make("arun_test"),
      sessionID: Session.ID.make("ses_child"),
      callerSessionID: Session.ID.make("ses_parent"),
      previousRunID: undefined,
      source: { messageID: SessionMessage.ID.make("msg_source"), callID: "call_1" },
      agent: Agent.ID.make("build"),
      description: "Review the implementation",
      model: undefined,
      background: true,
      state: { type: "interrupted", reason: undefined },
      activity: { at: DateTime.makeUnsafe(20), summary: undefined },
      time: {
        created: DateTime.makeUnsafe(10),
        started: undefined,
        updated: DateTime.makeUnsafe(20),
        finished: undefined,
      },
      version: 1,
    })

    expect(DateTime.toEpochMillis(info.activity.at)).toBe(20)
    expect(Schema.encodeSync(AgentRun.Info)(info)).toEqual({
      id: "arun_test",
      sessionID: "ses_child",
      callerSessionID: "ses_parent",
      source: { messageID: "msg_source", callID: "call_1" },
      agent: "build",
      description: "Review the implementation",
      background: true,
      state: { type: "interrupted" },
      activity: { at: 20 },
      time: { created: 10, updated: 20 },
      version: 1,
    })
  })

  test("decodes and encodes a Snapshot with session nodes, active runs, and history", () => {
    const running = {
      id: "arun_current",
      sessionID: "ses_child",
      callerSessionID: "ses_root",
      source: { messageID: "msg_source", callID: "call_1" },
      agent: "build",
      description: "Review the implementation",
      background: true,
      state: { type: "running" },
      activity: { at: 20 },
      time: { created: 10, updated: 20 },
      version: 1,
    } as const
    const input = {
      rootSessionID: "ses_root",
      nodes: [
        {
          sessionID: "ses_child",
          parentSessionID: "ses_root",
          title: "Reviewer",
          createdAt: 10,
        },
      ],
      active: [running],
      history: [{ ...running, id: "arun_previous", state: { type: "succeeded" }, version: 2 }],
    } as const

    const snapshot = Schema.decodeUnknownSync(AgentRun.Snapshot)(input)
    expect(DateTime.toEpochMillis(snapshot.nodes[0].createdAt)).toBe(10)
    expect(snapshot.nodes[0].agent).toBeUndefined()
    expect(Schema.encodeSync(AgentRun.Snapshot)(snapshot)).toEqual(input)
  })

  test("decodes and encodes an Overview without a single root session", () => {
    const input = {
      nodes: [],
      active: [],
      history: [],
    }

    const overview = Schema.decodeUnknownSync(AgentRun.Overview)(input)

    expect(SchemaAST.resolveIdentifier(AgentRun.Overview.ast)).toBe("AgentRun.Overview")
    expect(Schema.encodeSync(AgentRun.Overview)(overview)).toEqual(input)
    expect("rootSessionID" in overview).toBe(false)
  })

  test("registers agent.run.updated as a live public event carrying Info", () => {
    expect(AgentRun.Event.Updated.type).toBe("agent.run.updated")
    expect(AgentRun.Event.Updated.data.fields.info).toBe(AgentRun.Info)
    expect(AgentRun.Event.Definitions).toEqual([AgentRun.Event.Updated])
    expect(EventManifest.ServerDefinitions).toContain(AgentRun.Event.Updated)
    expect(EventManifest.Definitions).toContain(AgentRun.Event.Updated)
    expect(EventManifest.Latest.get("agent.run.updated")).toBe(AgentRun.Event.Updated)
    expect("durable" in AgentRun.Event.Updated).toBe(false)
    expect(EventManifest.Durable.has("agent.run.updated.1")).toBe(false)
  })
})
