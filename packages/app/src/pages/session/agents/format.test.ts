import { describe, expect, test } from "bun:test"
import { Agent, AgentRun, Session, SessionMessage } from "@opencode-ai/schema"
import { DateTime } from "effect"
import { formatElapsed } from "./format"

function run(input: {
  state?: AgentRun.State
  created?: number
  started?: number
  updated?: number
  finished?: number
}) {
  const state = input.state ?? { type: "running" }
  return AgentRun.Info.make({
    id: AgentRun.ID.make("arun_elapsed"),
    sessionID: Session.ID.make("ses_elapsed"),
    callerSessionID: Session.ID.make("ses_root"),
    source: { messageID: SessionMessage.ID.make("msg_elapsed"), callID: "call_elapsed" },
    agent: Agent.ID.make("build"),
    description: "Elapsed run",
    background: true,
    state,
    activity: { at: DateTime.makeUnsafe(input.updated ?? 0) },
    time: {
      created: DateTime.makeUnsafe(input.created ?? 0),
      started: input.started === undefined ? undefined : DateTime.makeUnsafe(input.started),
      updated: DateTime.makeUnsafe(input.updated ?? 0),
      finished: input.finished === undefined ? undefined : DateTime.makeUnsafe(input.finished),
    },
    version: 1,
  })
}

describe("formatElapsed", () => {
  test.each([
    [0, "0s"],
    [59, "59s"],
    [60, "1m 0s"],
    [61, "1m 1s"],
    [3_600, "1h 0m 0s"],
    [3_661, "1h 1m 1s"],
  ])("preserves English output for %i seconds", (seconds, expected) => {
    expect(formatElapsed(run({}), seconds * 1_000, "en")).toBe(expected)
  })

  test("uses running, finished, and clamped elapsed boundaries", () => {
    expect(formatElapsed(run({ started: 1_000, updated: 2_000 }), 62_000, "en")).toBe("1m 1s")
    expect(
      formatElapsed(
        run({ state: { type: "succeeded" }, started: 1_000, updated: 2_000, finished: 61_000 }),
        100_000,
        "en",
      ),
    ).toBe("1m 0s")
    expect(formatElapsed(run({ started: 2_000 }), 1_000, "en")).toBe("0s")
  })

  test("localizes digits and units", () => {
    expect(formatElapsed(run({}), 61_000, "ar")).toBe("١ د و١ ث")
  })
})
