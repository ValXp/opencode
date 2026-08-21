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

function overview(info = run({ state: { type: "running" } })) {
  return AgentRun.Overview.make({
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

function activeOverview(rootSessionID: string, childSessionID: string) {
  const root = Session.ID.make(rootSessionID)
  const info = run({
    id: `arun_${childSessionID}`,
    sessionID: childSessionID,
    rootSessionID,
    state: { type: "running" },
  })
  return AgentRun.Overview.make({
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

function overviewWithBranch(info: AgentRun.Info) {
  return overviewWithBranches(info)
}

function overviewWithBranches(...infos: AgentRun.Info[]) {
  const current = overview()
  return AgentRun.Overview.make({
    nodes: [
      ...current.nodes,
      ...infos.map((info) =>
        AgentRun.Node.make({
          sessionID: info.sessionID,
          parentSessionID: info.callerSessionID,
          title: "New branch",
          createdAt: DateTime.makeUnsafe(2_000),
        }),
      ),
    ],
    active: [
      ...current.active,
      ...infos.filter((info) => info.state.type === "running" || info.state.type === "retrying"),
    ],
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

test("loads one server-wide overview and exposes query state", async () => {
  let calls = 0
  const eventLayer = events()
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        calls++
        return overview()
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  expect(owner.agents.loading()).toBeTrue()
  await settle()

  expect(calls).toBe(1)
  expect(owner.agents.loading()).toBeFalse()
  expect(owner.agents.error()).toBeUndefined()
  expect(owner.agents.lastSuccessAt()).toBe(3_000)
  expect(owner.agents.overview()?.nodes).toHaveLength(1)
  expect(owner.agents.projection().rows.map((row) => String(row.node.sessionID))).toEqual(["ses_child"])

  owner.dispose()
})

test("applies another tree's run event received while the initial overview is loading", async () => {
  const eventLayer = events()
  const response = Promise.withResolvers<AgentRun.Overview>()
  const stale = run({
    id: "arun_startup_other",
    sessionID: "ses_startup_other",
    rootSessionID: "ses_other_root",
    state: { type: "running" },
  })
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: () => response.promise,
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(
        run({
          id: "arun_startup_other",
          sessionID: "ses_startup_other",
          rootSessionID: "ses_other_root",
          state: { type: "succeeded" },
          version: 2,
        }),
      ),
    },
  })
  response.resolve(overviewWithBranch(stale))
  await settle()

  expect(owner.agents.projection().rows.map((row) => [String(row.node.sessionID), row.state.type])).toEqual([
    ["ses_child", "running"],
    ["ses_startup_other", "succeeded"],
  ])
  owner.dispose()
})

test("owns one freshness timer only while the overview has active runs", async () => {
  let calls = 0
  const eventLayer = events()
  const time = clock(3_000)
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        calls++
        return overview()
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
  expect(calls).toBe(1)

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
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => overview(),
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

test("keeps the global overview and panel state across session route changes", async () => {
  const [sessionID, setSessionID] = createSignal("ses_child_a")
  let requests = 0
  const time = clock(3_000)
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => {
        sessionID()
        return "server"
      },
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        return activeOverview("ses_root_a", "ses_child_a")
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

  setSessionID("ses_child_b")
  await settle()
  expect(requests).toBe(1)
  expect(owner.agents.overview()?.nodes.map((node) => String(node.sessionID))).toEqual(["ses_child_a"])
  expect(owner.agents.showHistory()).toBeTrue()
  expect(owner.agents.expanded("ses_child_a")).toBeTrue()
  expect(owner.agents.mobileDrawerOpen()).toBeTrue()
  expect(time.active()).toBe(1)
  owner.dispose()
  expect(time.active()).toBe(0)
})

test("isolates overview data and event journals when the connected server changes", async () => {
  const [serverKey, setServerKey] = createSignal("server-a")
  const eventLayer = events()
  const staleServerA = Promise.withResolvers<AgentRun.Overview>()
  const serverB = Promise.withResolvers<AgentRun.Overview>()
  const calls: string[] = []
  let serverARequests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: serverKey,
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        const key = serverKey()
        calls.push(key)
        if (key === "server-b") return serverB.promise
        serverARequests++
        if (serverARequests === 1) return overview()
        return staleServerA.promise
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  const staleRefresh = owner.agents.refresh()
  await settle()
  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(run({ state: { type: "failed", error: "server a" }, version: 3 })),
    },
  })
  expect(owner.agents.projection().rows[0]?.current?.version).toBe(3)

  owner.agents.setShowHistory(true)
  setServerKey("server-b")
  await settle()
  expect(owner.agents.overview()).toBeUndefined()
  expect(owner.agents.showHistory()).toBeFalse()

  serverB.resolve(overview())
  await settle()
  await settle()
  expect(calls).toEqual(["server-a", "server-a", "server-b"])
  expect(owner.agents.projection().rows[0]?.current?.version).toBe(1)
  expect(owner.agents.projection().rows[0]?.state.type).toBe("running")

  staleServerA.resolve(overview(run({ state: { type: "succeeded" }, version: 2 })))
  await staleRefresh
  await settle()
  expect(owner.agents.projection().rows[0]?.current?.version).toBe(1)
  expect(owner.agents.projection().rows[0]?.state.type).toBe("running")
  owner.dispose()
})

test("preserves the last overview and reports stale data when refresh fails", async () => {
  let requests = 0
  let currentTime = 3_000
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
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
  expect(owner.agents.overview()?.nodes).toHaveLength(1)
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
  const refreshed = Promise.withResolvers<AgentRun.Overview>()
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
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
  refreshed.resolve(overview())
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
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        return overview()
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
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        return overview()
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

test("coalesces unknown-node events into one partial-overview repair", async () => {
  const eventLayer = events()
  const repair = Promise.withResolvers<AgentRun.Overview>()
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
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
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

  repair.resolve(overviewWithBranch(unknown))
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
  const firstRepair = Promise.withResolvers<AgentRun.Overview>()
  const newerRepair = Promise.withResolvers<AgentRun.Overview>()
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
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
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

  firstRepair.resolve(overview())
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

  newerRepair.resolve(overviewWithBranch(newer))
  await owner.agents.refresh()
  await settle()
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.projection().rows.find((row) => row.current?.id === newer.id)?.state.type).toBe("succeeded")
  owner.dispose()
})

test("repairs an unknown run received after the previous repair overview was captured", async () => {
  const eventLayer = events()
  const captured = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const followupStarted = Promise.withResolvers<void>()
  const followup = Promise.withResolvers<AgentRun.Overview>()
  const first = run({ id: "arun_capture_a", sessionID: "ses_capture_a", state: { type: "running" }, version: 1 })
  const second = run({ id: "arun_capture_b", sessionID: "ses_capture_b", state: { type: "running" }, version: 1 })
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
        if (requests === 2) {
          captured.resolve()
          await release.promise
          return overviewWithBranch(first)
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
  followup.resolve(overviewWithBranches(first, second))
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

test("repairs journal overflow once and preserves the first evicted run", async () => {
  const eventLayer = events()
  const stale = Promise.withResolvers<AgentRun.Overview>()
  const infos = Array.from({ length: 257 }, (_, index) =>
    run({
      id: `arun_overflow_${index}`,
      sessionID: "ses_child",
      state: { type: "running" },
      version: 1,
    }),
  )
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
        if (requests === 2) return stale.promise
        if (requests === 3) throw new Error("repair unavailable")
        const current = overview()
        return AgentRun.Overview.make({ ...current, active: [...current.active, ...infos] })
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  const refresh = owner.agents.refresh()
  await settle()
  infos.forEach((info) =>
    eventLayer.emit({
      type: "agent.run.updated",
      properties: { info: Schema.encodeSync(AgentRun.Info)(info) },
    }),
  )
  stale.resolve(overview())
  await refresh
  await settle()

  expect(requests).toBe(3)
  expect(owner.agents.partial()).toBeTrue()
  await settle()
  expect(requests).toBe(3)

  await owner.agents.refresh()
  await settle()

  expect(requests).toBe(4)
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.overview()?.active.some((info) => info.id === infos[0]?.id)).toBeTrue()
  owner.dispose()
})

test("replays newer run events after an unknown-node repair overview", async () => {
  const eventLayer = events()
  const repair = Promise.withResolvers<AgentRun.Overview>()
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
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
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
  repair.resolve(overviewWithBranch(unknown))
  await owner.agents.refresh()
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.projection().rows.map((row) => row.state.type)).toEqual(["succeeded", "succeeded"])
  owner.dispose()
})

test("repairs and applies run events from another session tree", async () => {
  const eventLayer = events()
  const unrelated = run({
    id: "arun_unrelated",
    sessionID: "ses_unrelated_child",
    rootSessionID: "ses_unrelated_root",
    state: { type: "running" },
  })
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        return requests === 1 ? overview() : overviewWithBranch(unrelated)
      },
      events: eventLayer,
      now: () => 3_000,
    }),
  }))

  await settle()
  eventLayer.emit({
    type: "agent.run.updated",
    properties: {
      info: Schema.encodeSync(AgentRun.Info)(unrelated),
    },
  })
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.partial()).toBeFalse()
  expect(owner.agents.warning()).toBeUndefined()
  expect(owner.agents.projection().rows.map((row) => [String(row.node.sessionID), row.depth])).toEqual([
    ["ses_child", 0],
    ["ses_unrelated_child", 0],
  ])
  expect(owner.agents.projection().activeCount).toBe(2)
  owner.dispose()
})

test("refetches from the server-wide stream once for each new connection", async () => {
  const serverEvents = events()
  const reconnect = Promise.withResolvers<AgentRun.Overview>()
  const newer = run({ state: { type: "failed", error: "newer event" }, version: 3 })
  let requests = 0
  const owner = createRoot((dispose) => ({
    dispose,
    agents: createAgentsContext({
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        if (requests === 1) return overview()
        if (requests === 2) return reconnect.promise
        return overview(newer)
      },
      events: serverEvents,
      initialConnectionID: "evt_initial",
      now: () => 3_000,
    }),
  }))

  await settle()
  serverEvents.emit({ id: "evt_reconnect_1", type: "server.connected", properties: {} })
  await settle()
  serverEvents.emit({
    type: "agent.run.updated",
    properties: { info: Schema.encodeSync(AgentRun.Info)(newer) },
  })
  reconnect.resolve(overview(run({ state: { type: "succeeded" }, version: 2 })))
  await settle()

  expect(requests).toBe(2)
  expect(owner.agents.projection().rows[0]?.current?.version).toBe(3)
  expect(owner.agents.projection().rows[0]?.state?.type).toBe("failed")

  serverEvents.emit({ id: "evt_reconnect_1", type: "server.connected", properties: {} })
  await settle()
  expect(requests).toBe(2)

  serverEvents.emit({ id: "evt_reconnect_2", type: "server.connected", properties: {} })
  await settle()
  expect(requests).toBe(3)
  owner.dispose()
})

test("refetches a cached overview when the context remounts", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let requests = 0
  const mount = () =>
    createRoot((dispose) => ({
      dispose,
      agents: createAgentsContext({
        queryKey: () => "server",
        queryClient,
        fetchOverview: async () => {
          requests++
          return requests === 1 ? overview() : overview(run({ state: { type: "succeeded" }, version: 2 }))
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
      queryKey: () => "server",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      fetchOverview: async () => {
        requests++
        return overview()
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
