import { expect, test } from "bun:test"
import { Agent, AgentRun, Session, SessionMessage } from "@opencode-ai/schema"
import { QueryClient } from "@tanstack/solid-query"
import { DateTime, Schema } from "effect"
import { createRoot, createSignal } from "solid-js"
import { createAgentsContext } from "@/pages/session/agents/context"

const rootID = Session.ID.make("ses_root")

function run(input: {
  state: AgentRun.State
  version?: number
  id?: string
  sessionID?: string
  rootSessionID?: string
}) {
  const id = input.id ?? "arun_child"
  const sessionID = input.sessionID ?? "ses_child"
  return AgentRun.Info.make({
    id: AgentRun.ID.make(id),
    sessionID: Session.ID.make(sessionID),
    callerSessionID: Session.ID.make(input.rootSessionID ?? rootID),
    source: { messageID: SessionMessage.ID.make(`msg_${id}`), callID: `call_${id}` },
    agent: Agent.ID.make("build"),
    description: "Build child",
    background: true,
    state: input.state,
    activity: { at: DateTime.makeUnsafe(2_000) },
    time: { created: DateTime.makeUnsafe(1_000), updated: DateTime.makeUnsafe(2_000) },
    version: input.version ?? 1,
  })
}

function snapshot(info = run({ state: { type: "running" } })) {
  return AgentRun.Snapshot.make({
    rootSessionID: rootID,
    nodes: [
      AgentRun.Node.make({
        sessionID: Session.ID.make("ses_child"),
        parentSessionID: rootID,
        title: "Child",
        createdAt: DateTime.makeUnsafe(1_000),
      }),
    ],
    active: info.state.type === "running" || info.state.type === "retrying" ? [info] : [],
    history: info.state.type === "running" || info.state.type === "retrying" ? [] : [info],
  })
}

function emptySnapshot(rootSessionID: string) {
  return AgentRun.Snapshot.make({
    rootSessionID: Session.ID.make(rootSessionID),
    nodes: [],
    active: [],
    history: [],
  })
}

function activeSnapshot(rootSessionID: string, childSessionID: string) {
  const root = Session.ID.make(rootSessionID)
  const info = run({
    id: `arun_${childSessionID}`,
    sessionID: childSessionID,
    rootSessionID,
    state: { type: "running" },
  })
  return AgentRun.Snapshot.make({
    rootSessionID: root,
    nodes: [
      AgentRun.Node.make({
        sessionID: info.sessionID,
        parentSessionID: root,
        title: childSessionID,
        createdAt: DateTime.makeUnsafe(1_000),
      }),
    ],
    active: [info],
    history: [],
  })
}

function snapshotWithBranch(info: AgentRun.Info) {
  return snapshotWithBranches(info)
}

function snapshotWithBranches(...infos: AgentRun.Info[]) {
  const current = snapshot()
  return AgentRun.Snapshot.make({
    rootSessionID: rootID,
    nodes: [
      ...current.nodes,
      ...infos.map((info) =>
        AgentRun.Node.make({
          sessionID: info.sessionID,
          parentSessionID: rootID,
          title: "New branch",
          createdAt: DateTime.makeUnsafe(2_000),
        }),
      ),
    ],
    active: [...current.active, ...infos.filter((info) => info.state.type === "running" || info.state.type === "retrying")],
    history: infos.filter((info) => info.state.type !== "running" && info.state.type !== "retrying"),
  })
}

function events() {
  const listeners = new Set<(event: unknown) => void>()
  return {
    listen(listener: (event: unknown) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event: unknown) {
      listeners.forEach((listener) => listener(event))
    },
    size: () => listeners.size,
  }
}

function clock(initial: number) {
  const timers = new Map<number, () => void>()
  let current = initial
  let nextID = 0
  return {
    now: () => current,
    setInterval: (callback: () => void) => {
      const id = ++nextID
      timers.set(id, callback)
      return id
    },
    clearInterval: (id: number) => {
      timers.delete(id)
    },
    tick(ms: number) {
      current += ms
      timers.forEach((callback) => callback())
    },
    active: () => timers.size,
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test("loads one snapshot for the derived root and exposes query state", async () => {
  const calls: string[] = []
  const eventLayer = events()
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_child",
      getSession: (sessionID) =>
        sessionID === "ses_child" ? { id: "ses_child", parentID: "ses_root" } : { id: "ses_root" },
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async (sessionID) => {
        calls.push(sessionID)
        return snapshot()
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  expect(owner.agents.loading()).toBeTrue()
  await settle()

  expect(calls).toEqual(["ses_root"])
  expect(owner.agents.loading()).toBeFalse()
  expect(owner.agents.error()).toBeUndefined()
  expect(owner.agents.lastSuccessAt()).toBe(3_000)
  expect(String(owner.agents.snapshot()?.rootSessionID)).toBe("ses_root")
  expect(owner.agents.projection().rows.map((row) => String(row.node.sessionID))).toEqual(["ses_child"])

  owner.dispose()
})

test("applies run events received while the initial snapshot is loading", async () => {
  const eventLayer = events()
  const response = Promise.withResolvers<AgentRun.Snapshot>()
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: () => response.promise,
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(run({ state: { type: "succeeded" }, version: 2 })),
    },
  })
  response.resolve(snapshot())
  await settle()

  expect(owner.agents.projection().rows[0]?.state.type).toBe("succeeded")
  owner.dispose()
})

test("loads the highest known parent when the viewed child's ancestor is missing", async () => {
  const calls: string[] = []
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_child",
      getSession: (sessionID) =>
        sessionID === "ses_child" ? { id: "ses_child", parentID: "ses_missing_root" } : undefined,
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async (sessionID) => {
        calls.push(sessionID)
        return emptySnapshot(sessionID)
      },
      events: events(),
    }),
  }))

  await settle()

  expect(calls).toEqual(["ses_missing_root"])
  expect(owner.agents.rootSessionID()).toBe("ses_missing_root")
  expect(owner.agents.loading()).toBeFalse()
  owner.dispose()
})

test("owns one freshness timer only while the snapshot has active runs", async () => {
  const calls: string[] = []
  const eventLayer = events()
  const time = clock(3_000)
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async (sessionID) => {
        calls.push(sessionID)
        return snapshot()
      },
      events: eventLayer,
      now: time.now,
      setInterval: time.setInterval,
      clearInterval: time.clearInterval,
    }),
  }))

  expect(time.active()).toBe(0)
  await settle()
  expect(owner.agents.projection().rows[0]?.freshness?.ageMs).toBe(1_000)
  expect(time.active()).toBe(1)

  time.tick(5_000)

  expect(owner.agents.projection().rows[0]?.freshness?.ageMs).toBe(6_000)
  expect(calls).toEqual(["ses_root"])

  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(run({ state: { type: "succeeded" }, version: 2 })),
    },
  })

  expect(time.active()).toBe(0)
  owner.dispose()
})

test("owns history, row expansion, and mobile drawer state", () => {
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => snapshot(),
      events: events(),
    }),
  }))

  expect(owner.agents.showHistory()).toBeFalse()
  expect(owner.agents.expanded("ses_child")).toBeFalse()
  expect(owner.agents.mobileDrawerOpen()).toBeFalse()

  owner.agents.toggleShowHistory()
  owner.agents.toggleExpanded("ses_child")
  owner.agents.setMobileDrawerOpen(true)

  expect(owner.agents.showHistory()).toBeTrue()
  expect(owner.agents.expanded("ses_child")).toBeTrue()
  expect(owner.agents.mobileDrawerOpen()).toBeTrue()

  owner.agents.setShowHistory(false)
  owner.agents.setExpanded("ses_child", false)
  owner.agents.toggleMobileDrawer()

  expect(owner.agents.showHistory()).toBeFalse()
  expect(owner.agents.expanded("ses_child")).toBeFalse()
  expect(owner.agents.mobileDrawerOpen()).toBeFalse()
  owner.dispose()
})

test("keeps state within one root and resets root-scoped state when the viewed root changes", async () => {
  const [sessionID, setSessionID] = createSignal("ses_child_a")
  const sessions: Record<string, { id: string; parentID?: string }> = {
    ses_child_a: { id: "ses_child_a", parentID: "ses_root_a" },
    ses_sibling_a: { id: "ses_sibling_a", parentID: "ses_root_a" },
    ses_root_a: { id: "ses_root_a" },
    ses_child_b: { id: "ses_child_b", parentID: "ses_root_b" },
    ses_root_b: { id: "ses_root_b" },
  }
  const nextRoot = Promise.withResolvers<AgentRun.Snapshot>()
  const calls: string[] = []
  const time = clock(3_000)
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID,
      getSession: (id) => sessions[id],
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async (root) => {
        calls.push(root)
        if (root === "ses_root_b") return nextRoot.promise
        return activeSnapshot(root, "ses_child_a")
      },
      events: events(),
      now: time.now,
      setInterval: time.setInterval,
      clearInterval: time.clearInterval,
    }),
  }))

  await settle()
  expect(time.active()).toBe(1)
  owner.agents.setShowHistory(true)
  owner.agents.setExpanded("ses_child_a", true)
  owner.agents.setMobileDrawerOpen(true)

  setSessionID("ses_sibling_a")
  await settle()
  expect(calls).toEqual(["ses_root_a"])
  expect(owner.agents.showHistory()).toBeTrue()

  setSessionID("ses_child_b")
  await settle()
  expect(calls).toEqual(["ses_root_a", "ses_root_b"])
  expect(owner.agents.snapshot()).toBeUndefined()
  expect(owner.agents.lastSuccessAt()).toBeUndefined()
  expect(owner.agents.showHistory()).toBeFalse()
  expect(owner.agents.expanded("ses_child_a")).toBeFalse()
  expect(owner.agents.mobileDrawerOpen()).toBeFalse()
  expect(owner.agents.loading()).toBeTrue()
  expect(time.active()).toBe(0)

  nextRoot.resolve(emptySnapshot("ses_root_b"))
  await owner.agents.refresh()
  await settle()
  expect(String(owner.agents.snapshot()?.rootSessionID)).toBe("ses_root_b")
  expect(time.active()).toBe(0)

  setSessionID("ses_child_a")
  await settle()
  expect(calls).toEqual(["ses_root_a", "ses_root_b", "ses_root_a"])
  expect(time.active()).toBe(1)
  owner.dispose()
  expect(time.active()).toBe(0)
})

test("preserves the last snapshot and reports stale data when refresh fails", async () => {
  let requests = 0
  let currentTime = 3_000
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        if (requests === 1) return snapshot()
        throw new Error("offline")
      },
      events: events(),
      now: () => currentTime,
    }),
  }))

  await settle()
  expect(owner.agents.lastSuccessAt()).toBe(3_000)
  currentTime = 4_000

  await owner.agents.refresh()
  await settle()

  expect(requests).toBe(2)
  expect(String(owner.agents.snapshot()?.rootSessionID)).toBe("ses_root")
  const error = owner.agents.error()
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected refresh error")
  expect(error.message).toBe("offline")
  expect(owner.agents.lastSuccessAt()).toBe(3_000)
  expect(owner.agents.stale()).toBeTrue()
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.warning()).toEqual({ stale: true, partial: false })
  owner.dispose()
})

test("replays run events received during an ordinary refresh", async () => {
  const eventLayer = events()
  const refreshed = Promise.withResolvers<AgentRun.Snapshot>()
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        if (requests === 1) return snapshot()
        return refreshed.promise
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  const refresh = owner.agents.refresh()
  await settle()
  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(run({ state: { type: "succeeded" }, version: 2 })),
    },
  })
  refreshed.resolve(snapshot())
  await refresh
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.projection().rows[0]?.current?.version).toBe(2)
  expect(owner.agents.projection().rows[0]?.state.type).toBe("succeeded")
  owner.dispose()
})

test("decodes versioned run events and updates a known node without refetching", async () => {
  const eventLayer = events()
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        return snapshot()
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  eventLayer.emit({ type: "agent.run.updated", properties: { info: { id: "invalid" } } })
  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(run({ state: { type: "succeeded" }, version: 2 })),
    },
  })

  expect(owner.agents.projection().rows[0]?.state?.type).toBe("succeeded")
  expect(requests).toBe(1)

  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(run({ state: { type: "running" }, version: 1 })),
    },
  })

  expect(owner.agents.projection().rows[0]?.state?.type).toBe("succeeded")
  expect(requests).toBe(1)
  owner.dispose()
})

test("applies live run events encoded with stream timestamps", async () => {
  const eventLayer = events()
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        return snapshot()
      },
      events: eventLayer,
      now: () => 4_000,
    }),
  }))

  await settle()
  const info = Schema.encodeSync(AgentRun.Info)(run({ state: { type: "running" }, version: 2 }))
  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: {
        ...info,
        activity: { ...info.activity, at: "1970-01-01T00:00:03.000Z", summary: "Still working" },
        time: {
          ...info.time,
          created: "1970-01-01T00:00:01.000Z",
          updated: "1970-01-01T00:00:03.000Z",
        },
      },
    },
  })

  expect(owner.agents.projection().rows[0]?.current?.version).toBe(2)
  expect(owner.agents.projection().rows[0]?.current?.activity.summary).toBe("Still working")
  expect(owner.agents.projection().rows[0]?.freshness?.ageMs).toBe(1_000)
  expect(requests).toBe(1)
  owner.dispose()
})

test("coalesces unknown-node events into one partial-snapshot repair", async () => {
  const eventLayer = events()
  const repair = Promise.withResolvers<AgentRun.Snapshot>()
  const unknown = run({
    id: "arun_new",
    sessionID: "ses_new",
    state: { type: "running" },
    version: 1,
  })
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        if (requests === 1) return snapshot()
        return repair.promise
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  const event = {
    type: "agent.run.updated",
    properties: { info: Schema.encodeSync(AgentRun.Info)(unknown) },
  }
  eventLayer.emit(event)
  eventLayer.emit(event)
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.partial()).toBeTrue()
  expect(owner.agents.warning()).toEqual({ stale: false, partial: true })
  expect(owner.agents.projection().rows.map((row) => String(row.node.sessionID))).toEqual(["ses_child"])

  repair.resolve(snapshotWithBranch(unknown))
  await owner.agents.refresh()
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.warning()).toBeUndefined()
  expect(owner.agents.projection().rows.map((row) => String(row.node.sessionID))).toEqual(["ses_child", "ses_new"])
  owner.dispose()
})

test("repairs each unknown run version at most once when its node stays absent", async () => {
  const eventLayer = events()
  const firstRepair = Promise.withResolvers<AgentRun.Snapshot>()
  const newerRepair = Promise.withResolvers<AgentRun.Snapshot>()
  const unknown = run({
    id: "arun_deleted_child",
    sessionID: "ses_deleted_child",
    state: { type: "running" },
    version: 1,
  })
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        if (requests === 1) return snapshot()
        if (requests === 2) return firstRepair.promise
        return newerRepair.promise
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))
  const event = (info: AgentRun.Info) => ({
    type: "agent.run.updated",
    properties: { info: Schema.encodeSync(AgentRun.Info)(info) },
  })

  await settle()
  eventLayer.emit(event(unknown))
  await settle()
  expect(requests).toBe(2)

  firstRepair.resolve(snapshot())
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.partial()).toBeTrue()
  eventLayer.emit(event(unknown))
  await settle()
  expect(requests).toBe(2)

  const newer = run({
    id: "arun_deleted_child",
    sessionID: "ses_deleted_child",
    state: { type: "succeeded" },
    version: 2,
  })
  eventLayer.emit(event(newer))
  await settle()
  expect(requests).toBe(3)

  newerRepair.resolve(snapshotWithBranch(newer))
  await owner.agents.refresh()
  await settle()
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.projection().rows.find((row) => row.current?.id === newer.id)?.state.type).toBe("succeeded")
  owner.dispose()
})

test("repairs an unknown run received after the previous repair snapshot was captured", async () => {
  const eventLayer = events()
  const captured = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const followupStarted = Promise.withResolvers<void>()
  const followup = Promise.withResolvers<AgentRun.Snapshot>()
  const first = run({ id: "arun_capture_a", sessionID: "ses_capture_a", state: { type: "running" }, version: 1 })
  const second = run({ id: "arun_capture_b", sessionID: "ses_capture_b", state: { type: "running" }, version: 1 })
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        if (requests === 1) return snapshot()
        if (requests === 2) {
          captured.resolve()
          await release.promise
          return snapshotWithBranch(first)
        }
        followupStarted.resolve()
        return followup.promise
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))
  const event = (info: AgentRun.Info) => ({
    type: "agent.run.updated",
    properties: { info: Schema.encodeSync(AgentRun.Info)(info) },
  })

  await settle()
  eventLayer.emit(event(first))
  await captured.promise
  eventLayer.emit(event(second))
  release.resolve()
  await followupStarted.promise

  expect(requests).toBe(3)
  expect(owner.agents.partial()).toBeTrue()
  followup.resolve(snapshotWithBranches(first, second))
  await owner.agents.refresh()
  await settle()

  expect(requests).toBe(3)
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.projection().rows.map((row) => String(row.node.sessionID))).toEqual([
    "ses_child",
    "ses_capture_a",
    "ses_capture_b",
  ])
  owner.dispose()
})

test("replays newer run events after an unknown-node repair snapshot", async () => {
  const eventLayer = events()
  const repair = Promise.withResolvers<AgentRun.Snapshot>()
  const unknown = run({
    id: "arun_repair_new",
    sessionID: "ses_repair_new",
    state: { type: "running" },
    version: 1,
  })
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        if (requests === 1) return snapshot()
        return repair.promise
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  eventLayer.emit({
    type: "agent.run.updated",
    properties: { info: Schema.encodeSync(AgentRun.Info)(unknown) },
  })
  await settle()

  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(
        run({ id: "arun_repair_new", sessionID: "ses_repair_new", state: { type: "succeeded" }, version: 2 }),
      ),
    },
  })
  eventLayer.emit({
    type: "agent.run.updated",
    properties: { info: Schema.encodeSync(AgentRun.Info)(run({ state: { type: "succeeded" }, version: 2 })) },
  })
  repair.resolve(snapshotWithBranch(unknown))
  await owner.agents.refresh()
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.projection().rows.map((row) => row.state.type)).toEqual(["succeeded", "succeeded"])
  owner.dispose()
})

test("ignores agent-run events from an unrelated session tree", async () => {
  const eventLayer = events()
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        return snapshot()
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(
        run({
          id: "arun_unrelated",
          sessionID: "ses_unrelated_child",
          rootSessionID: "ses_unrelated_root",
          state: { type: "running" },
        }),
      ),
    },
  })
  await settle()

  expect(requests).toBe(1)
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.warning()).toBeUndefined()
  expect(owner.agents.projection().rows.map((row) => String(row.node.sessionID))).toEqual(["ses_child"])
  owner.dispose()
})

test("refetches from the global stream once for each new connection", async () => {
  const directoryEvents = events()
  const globalEvents = events()
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        if (requests === 1) return snapshot()
        return snapshot(run({ state: { type: "succeeded" }, version: 2 }))
      },
      events: [directoryEvents, globalEvents],
      initialConnectionID: "evt_initial",
      now: () => 3_000,
    }),
  }))

  await settle()
  globalEvents.emit({ id: "evt_reconnect_1", type: "server.connected", properties: {} })
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.projection().rows[0]?.state?.type).toBe("succeeded")

  globalEvents.emit({ id: "evt_reconnect_1", type: "server.connected", properties: {} })
  await settle()
  expect(requests).toBe(2)

  globalEvents.emit({ id: "evt_reconnect_2", type: "server.connected", properties: {} })
  await settle()
  expect(requests).toBe(3)
  owner.dispose()
})

test("refetches a cached snapshot when the context remounts", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let requests = 0
  const mount = () =>
    createRoot((dispose) => ({
      dispose,
      agents: createAgentsContext({
        sessionID: () => "ses_root",
        getSession: () => ({ id: "ses_root" }),
        queryKey: () => "server\0workspace",
        queryClient,
        fetchSnapshot: async () => {
          requests++
          return requests === 1
            ? snapshot()
            : snapshot(run({ state: { type: "succeeded" }, version: 2 }))
        },
        events: events(),
        now: () => 3_000,
      }),
    }))

  const first = mount()
  await settle()
  expect(first.agents.projection().rows[0]?.state.type).toBe("running")
  first.dispose()

  const second = mount()
  await settle()
  expect(requests).toBe(2)
  expect(second.agents.projection().rows[0]?.state.type).toBe("succeeded")
  second.dispose()
})

test("disposal removes the event listener and freshness timer", async () => {
  const eventLayer = events()
  const time = clock(3_000)
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      sessionID: () => "ses_root",
      getSession: () => ({ id: "ses_root" }),
      queryKey: () => "server\0workspace",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchSnapshot: async () => {
        requests++
        return snapshot()
      },
      events: eventLayer,
      now: time.now,
      setInterval: time.setInterval,
      clearInterval: time.clearInterval,
    }),
  }))

  await settle()
  expect(eventLayer.size()).toBe(1)
  expect(time.active()).toBe(1)

  owner.dispose()
  expect(eventLayer.size()).toBe(0)
  expect(time.active()).toBe(0)

  eventLayer.emit({ type: "server.connected", properties: {} })
  time.tick(1_000)
  await settle()
  expect(requests).toBe(1)
})
