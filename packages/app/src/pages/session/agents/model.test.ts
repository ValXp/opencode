import { describe, expect, test } from "bun:test"
import { Agent, AgentRun, Session, SessionMessage } from "@opencode-ai/schema"
import { DateTime } from "effect"
import { projectAgents, upsertAgentRun } from "./model"

const rootID = Session.ID.make("ses_root")

function node(sessionID: string, parentSessionID: string = rootID, createdAt = 0) {
  return AgentRun.Node.make({
    sessionID: Session.ID.make(sessionID),
    parentSessionID: Session.ID.make(parentSessionID),
    title: sessionID,
    createdAt: DateTime.makeUnsafe(createdAt),
  })
}

function run(input: {
  id: string
  sessionID: string
  state: AgentRun.State
  created: number
  started?: number
  updated?: number
  previousRunID?: string
  version?: number
}) {
  return AgentRun.Info.make({
    id: AgentRun.ID.make(input.id),
    sessionID: Session.ID.make(input.sessionID),
    callerSessionID: rootID,
    previousRunID: input.previousRunID ? AgentRun.ID.make(input.previousRunID) : undefined,
    source: { messageID: SessionMessage.ID.make(`msg_${input.id}`), callID: `call_${input.id}` },
    agent: Agent.ID.make("build"),
    description: input.id,
    background: true,
    state: input.state,
    activity: { at: DateTime.makeUnsafe(input.updated ?? input.created) },
    time: {
      created: DateTime.makeUnsafe(input.created),
      started: input.started === undefined ? undefined : DateTime.makeUnsafe(input.started),
      updated: DateTime.makeUnsafe(input.updated ?? input.created),
      finished:
        input.state.type === "running" || input.state.type === "retrying"
          ? undefined
          : DateTime.makeUnsafe(input.updated ?? input.created),
    },
    version: input.version ?? 1,
  })
}

function snapshot(input: { nodes: AgentRun.Node[]; active?: AgentRun.Info[]; history?: AgentRun.Info[] }) {
  return AgentRun.Snapshot.make({
    rootSessionID: rootID,
    nodes: input.nodes,
    active: input.active ?? [],
    history: input.history ?? [],
  })
}

describe("agents projection", () => {
  test("projects nested child sessions instead of invocation rows", () => {
    const child = run({ id: "arun_child", sessionID: "ses_child", state: { type: "running" }, created: 10 })
    const nested = run({ id: "arun_nested", sessionID: "ses_nested", state: { type: "succeeded" }, created: 20 })

    const result = projectAgents(
      snapshot({
        nodes: [node("ses_nested", "ses_child", 20), node("ses_child", rootID, 10)],
        active: [child],
        history: [nested],
      }),
      { now: 30 },
    )

    expect(result.rows.map((row) => [String(row.node.sessionID), row.depth, row.state?.type, row.contextOnly])).toEqual(
      [
        ["ses_child", 0, "running", false],
        ["ses_nested", 1, "succeeded", false],
      ],
    )
    expect(result.rows[0].freshness?.ageMs).toBe(20)
    expect(result.activeCount).toBe(1)
  })

  test("shows the 10 most recent terminal child sessions unless history is expanded", () => {
    const terminals = Array.from({ length: 12 }, (_, index) => {
      const suffix = index.toString().padStart(2, "0")
      return {
        node: node(`ses_terminal_${suffix}`, rootID, index),
        run: run({
          id: `arun_terminal_${suffix}`,
          sessionID: `ses_terminal_${suffix}`,
          state: { type: "succeeded" },
          created: index,
        }),
      }
    })
    const resumed = [
      run({
        id: "arun_terminal_11_resume_1",
        sessionID: "ses_terminal_11",
        state: { type: "succeeded" },
        created: 12,
        previousRunID: "arun_terminal_11",
      }),
      run({
        id: "arun_terminal_11_resume_2",
        sessionID: "ses_terminal_11",
        state: { type: "succeeded" },
        created: 13,
        previousRunID: "arun_terminal_11_resume_1",
      }),
    ]
    const data = snapshot({
      nodes: terminals.map((item) => item.node).reverse(),
      history: [...terminals.map((item) => item.run), ...resumed].reverse(),
    })
    const limited = projectAgents(data, { now: 100 })
    const expanded = projectAgents(data, { now: 100, showHistory: true })

    expect(limited.rows.map((row) => String(row.node.sessionID))).toEqual(
      terminals.slice(2).map((item) => String(item.node.sessionID)),
    )
    expect(expanded.rows.map((row) => String(row.node.sessionID))).toEqual(
      terminals.map((item) => String(item.node.sessionID)),
    )
    expect([limited.hiddenHistoryCount, expanded.hiddenHistoryCount]).toEqual([2, 2])
    expect([limited.totalCount, expanded.totalCount]).toEqual([12, 12])
  })

  test("keeps otherwise-hidden ancestors as nesting context", () => {
    const recent = Array.from({ length: 10 }, (_, index) => ({
      node: node(`ses_recent_${index}`, rootID, index + 10),
      run: run({
        id: `arun_recent_${index}`,
        sessionID: `ses_recent_${index}`,
        state: { type: "succeeded" },
        created: index + 10,
      }),
    }))
    const data = snapshot({
      nodes: [
        ...recent.map((item) => item.node),
        node("ses_active", "ses_ancestor", 1),
        node("ses_ancestor", rootID, 0),
      ],
      active: [run({ id: "arun_active", sessionID: "ses_active", state: { type: "running" }, created: 1 })],
      history: [
        ...recent.map((item) => item.run),
        run({ id: "arun_ancestor", sessionID: "ses_ancestor", state: { type: "succeeded" }, created: 0 }),
      ],
    })

    const result = projectAgents(data, { now: 100 })

    expect(result.rows.slice(0, 2).map((row) => [String(row.node.sessionID), row.depth, row.contextOnly])).toEqual([
      ["ses_ancestor", 0, true],
      ["ses_active", 1, false],
    ])
    expect(result.rows).toHaveLength(12)
    expect(result.activeCount).toBe(1)
  })

  test("does not invent lifecycle data for structural ancestors without runs", () => {
    const result = projectAgents(
      snapshot({
        nodes: [node("ses_parent"), node("ses_child", "ses_parent", 1)],
        active: [run({ id: "arun_child", sessionID: "ses_child", state: { type: "running" }, created: 1 })],
      }),
      { now: 10 },
    )

    expect(result.rows.map((row) => [String(row.node.sessionID), row.contextOnly, row.state?.type])).toEqual([
      ["ses_parent", true, undefined],
      ["ses_child", false, "running"],
    ])
    expect(result.rows[0].runs).toEqual([])
    expect(result.rows[0].freshness).toBeUndefined()
    expect(result.totalCount).toBe(1)
  })

  test("groups 67 runs by child session and preserves ordered resume history", () => {
    const resumed = Array.from({ length: 57 }, (_, index) => {
      const suffix = index.toString().padStart(2, "0")
      return run({
        id: `arun_resume_${suffix}`,
        sessionID: "ses_resumed",
        state: { type: "succeeded" },
        created: 1_000 - index,
        updated: 2_000 + index,
        previousRunID: index === 0 ? undefined : `arun_resume_${(index - 1).toString().padStart(2, "0")}`,
      })
    })
    const singleRuns = Array.from({ length: 10 }, (_, index) =>
      run({
        id: `arun_single_${index}`,
        sessionID: `ses_single_${index}`,
        state: { type: "succeeded" },
        created: index,
      }),
    )
    const data = snapshot({
      nodes: [
        node("ses_resumed", rootID, 100),
        ...singleRuns.map((item, index) => node(item.sessionID, rootID, index)),
      ],
      history: [...singleRuns, ...resumed].reverse(),
    })

    const limited = projectAgents(data, { now: 3_000 })
    const resumedRow = limited.rows.find((row) => String(row.node.sessionID) === "ses_resumed")

    expect(limited.rows).toHaveLength(10)
    expect(resumedRow?.resumeCount).toBe(56)
    expect(String(resumedRow?.current?.id)).toBe("arun_resume_56")
    expect(resumedRow?.runs.map((item) => String(item.id))).toEqual(resumed.map((item) => String(item.id)).reverse())
    expect(projectAgents(data, { now: 3_000, showHistory: true }).rows).toHaveLength(11)
  })

  test("shows the executing predecessor until its queued resume starts", () => {
    const executing = run({
      id: "arun_resume_1",
      sessionID: "ses_resumed",
      state: { type: "running" },
      created: 1_000,
      started: 1_100,
      updated: 2_900,
    })
    const queued = run({
      id: "arun_resume_2",
      sessionID: "ses_resumed",
      state: { type: "running" },
      created: 2_000,
      updated: 2_000,
      previousRunID: executing.id,
    })
    const data = snapshot({ nodes: [node("ses_resumed")], active: [executing, queued] })

    const waiting = projectAgents(data, { now: 3_000 })
    const started = projectAgents(
      snapshot({
        nodes: data.nodes.slice(),
        active: [executing, { ...queued, time: { ...queued.time, started: DateTime.makeUnsafe(3_000) } }],
      }),
      { now: 3_000 },
    )

    expect(String(waiting.rows[0].current?.id)).toBe("arun_resume_1")
    expect(String(started.rows[0].current?.id)).toBe("arun_resume_2")
    expect(waiting.rows[0].runs.map((item) => String(item.id))).toEqual(["arun_resume_2", "arun_resume_1"])
  })

  test("keeps a queued resume current when its predecessor chain is terminal or cyclic", () => {
    const terminal = run({
      id: "arun_terminal",
      sessionID: "ses_terminal_resume",
      state: { type: "succeeded" },
      created: 1_000,
      updated: 1_500,
    })
    const queued = run({
      id: "arun_queued",
      sessionID: "ses_terminal_resume",
      state: { type: "running" },
      created: 2_000,
      previousRunID: terminal.id,
    })
    const cycleA = run({
      id: "arun_cycle_a",
      sessionID: "ses_cycle_resume",
      state: { type: "running" },
      created: 3_000,
      previousRunID: "arun_cycle_b",
    })
    const cycleB = run({
      id: "arun_cycle_b",
      sessionID: "ses_cycle_resume",
      state: { type: "running" },
      created: 2_000,
      previousRunID: cycleA.id,
    })

    const result = projectAgents(
      snapshot({
        nodes: [node("ses_terminal_resume"), node("ses_cycle_resume")],
        active: [queued, cycleA, cycleB],
        history: [terminal],
      }),
      { now: 4_000 },
    )

    expect(String(result.rows.find((row) => row.node.sessionID === "ses_terminal_resume")?.current?.id)).toBe(
      "arun_queued",
    )
    expect(String(result.rows.find((row) => row.node.sessionID === "ses_cycle_resume")?.current?.id)).toBe(
      "arun_cycle_a",
    )
  })

  test("counts active child sessions rather than active runs", () => {
    const first = run({ id: "arun_multi_1", sessionID: "ses_multi", state: { type: "running" }, created: 1 })
    const resumed = run({
      id: "arun_multi_2",
      sessionID: "ses_multi",
      state: { type: "retrying", attempt: 1, message: "later", next: DateTime.makeUnsafe(50) },
      created: 2,
      previousRunID: first.id,
    })
    const staleActive = run({ id: "arun_done_1", sessionID: "ses_done", state: { type: "running" }, created: 3 })
    const finished = run({
      id: "arun_done_2",
      sessionID: "ses_done",
      state: { type: "succeeded" },
      created: 4,
      previousRunID: staleActive.id,
    })
    const data = snapshot({
      nodes: [node("ses_done"), node("ses_multi")],
      active: [first, resumed, staleActive],
      history: [finished],
    })

    const result = projectAgents(data, { now: 100 })

    expect(result.activeCount).toBe(1)
    expect(result.rows.map((row) => [String(row.node.sessionID), row.state?.type, row.resumeCount])).toEqual([
      ["ses_done", "succeeded", 1],
      ["ses_multi", "retrying", 1],
    ])
  })

  test("orders nodes deterministically with cycle and orphan guards", () => {
    const nodes = [
      node("ses_valid", rootID, 0),
      node("ses_valid_child", "ses_valid", 1),
      node("ses_orphan", "ses_missing", 2),
      node("ses_cycle_a", "ses_cycle_b", 3),
      node("ses_cycle_b", "ses_cycle_a", 4),
    ]
    const active = nodes.map((item, index) =>
      run({ id: `arun_guard_${index}`, sessionID: item.sessionID, state: { type: "running" }, created: index }),
    )
    const forward = projectAgents(snapshot({ nodes, active }), { now: 100 })
    const reversed = projectAgents(snapshot({ nodes: nodes.slice().reverse(), active: active.slice().reverse() }), {
      now: 100,
    })

    expect(forward.rows.map((row) => [String(row.node.sessionID), row.depth])).toEqual([
      ["ses_valid", 0],
      ["ses_valid_child", 1],
      ["ses_orphan", 0],
      ["ses_cycle_a", 0],
      ["ses_cycle_b", 1],
    ])
    expect(reversed.rows.map((row) => [String(row.node.sessionID), row.depth])).toEqual(
      forward.rows.map((row) => [String(row.node.sessionID), row.depth]),
    )
    expect(forward.activeCount).toBe(5)
  })

  test("ages started runs from the later of start and activity", () => {
    const result = projectAgents(
      snapshot({
        nodes: [node("ses_quiet")],
        active: [
          run({
            id: "arun_quiet",
            sessionID: "ses_quiet",
            state: { type: "running" },
            created: 10,
            started: 40,
            updated: 10,
          }),
        ],
      }),
      { now: 100, inactiveAfterMs: 50 },
    )

    expect(result.rows[0].state?.type).toBe("running")
    expect(result.rows[0].freshness).toMatchObject({ ageMs: 60, inactive: true })
    expect(DateTime.toEpochMillis(result.rows[0].freshness!.at)).toBe(40)
  })

  test("never marks an unstarted run inactive", () => {
    const result = projectAgents(
      snapshot({
        nodes: [node("ses_queued")],
        active: [
          run({ id: "arun_queued", sessionID: "ses_queued", state: { type: "running" }, created: 10, updated: 10 }),
        ],
      }),
      { now: 100, inactiveAfterMs: 50 },
    )

    expect(result.rows[0].freshness).toMatchObject({ ageMs: 90, inactive: false })
    expect(DateTime.toEpochMillis(result.rows[0].freshness!.at)).toBe(10)
  })

  test("uses a 60 second inactivity threshold by default", () => {
    const info = run({
      id: "arun_boundary",
      sessionID: "ses_boundary",
      state: { type: "running" },
      created: 1,
      started: 1,
      updated: 1,
    })
    const data = snapshot({ nodes: [node("ses_boundary")], active: [info] })

    expect(projectAgents(data, { now: 60_000 }).rows[0].freshness?.inactive).toBeFalse()
    expect(projectAgents(data, { now: 60_001 }).rows[0].freshness?.inactive).toBeTrue()
  })

  test("keeps terminal freshness age without marking the row inactive", () => {
    const result = projectAgents(
      snapshot({
        nodes: [node("ses_finished")],
        history: [
          run({
            id: "arun_finished",
            sessionID: "ses_finished",
            state: { type: "succeeded" },
            created: 10,
            updated: 10,
          }),
        ],
      }),
      { now: 100, inactiveAfterMs: 50 },
    )

    expect(result.rows[0].state?.type).toBe("succeeded")
    expect(result.rows[0].freshness).toMatchObject({ ageMs: 90, inactive: false })
  })

  test("rejects stale run events by version", () => {
    const current = run({
      id: "arun_versioned",
      sessionID: "ses_versioned",
      state: { type: "running" },
      created: 10,
      version: 3,
    })
    const data = snapshot({ nodes: [node("ses_versioned")], active: [current] })
    const stale = run({
      id: "arun_versioned",
      sessionID: "ses_versioned",
      state: { type: "succeeded" },
      created: 10,
      updated: 20,
      version: 2,
    })

    const result = upsertAgentRun(data, stale)

    expect(result).toBe(data)
    expect(result.active).toEqual([current])
    expect(result.history).toEqual([])
  })

  test("collapses repeated snapshot records to the newest run version", () => {
    const stale = run({
      id: "arun_repeated",
      sessionID: "ses_repeated",
      state: { type: "running" },
      created: 10,
      version: 1,
    })
    const current = run({
      id: "arun_repeated",
      sessionID: "ses_repeated",
      state: { type: "succeeded" },
      created: 10,
      updated: 20,
      version: 2,
    })

    const result = projectAgents(snapshot({ nodes: [node("ses_repeated")], active: [stale], history: [current] }), {
      now: 30,
    })

    expect(result.rows[0].runs).toEqual([current])
    expect([result.rows[0].state?.type, result.rows[0].resumeCount, result.activeCount]).toEqual(["succeeded", 0, 0])
  })

  test("moves a terminal child session out of active without dropping its runs", () => {
    const previous = run({ id: "arun_move_1", sessionID: "ses_move", state: { type: "running" }, created: 1 })
    const current = run({
      id: "arun_move_2",
      sessionID: "ses_move",
      state: { type: "running" },
      created: 2,
      previousRunID: previous.id,
      version: 1,
    })
    const terminal = run({
      id: "arun_move_2",
      sessionID: "ses_move",
      state: { type: "succeeded" },
      created: 2,
      updated: 3,
      previousRunID: previous.id,
      version: 2,
    })
    const data = snapshot({ nodes: [node("ses_move")], active: [previous, current] })

    const result = upsertAgentRun(data, terminal)
    const row = projectAgents(result, { now: 4 }).rows[0]

    expect(result.active).toEqual([])
    expect(result.history.map((item) => String(item.id))).toEqual(["arun_move_2", "arun_move_1"])
    expect([row.state?.type, row.resumeCount, row.active]).toEqual(["succeeded", 1, false])
  })
})
