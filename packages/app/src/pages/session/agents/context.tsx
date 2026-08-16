import { AgentRun } from "@opencode-ai/schema"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams } from "@solidjs/router"
import { createQuery, type QueryClient, skipToken } from "@tanstack/solid-query"
import { batch, createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { projectAgents, type AgentsProjection, upsertAgentRun } from "./model"
import {
  decodeAgentRunEvent,
  deriveRootSessionID,
  fetchAgentRunSnapshot,
  isServerConnectedEvent,
  serverConnectedEventID,
} from "./source"

const emptyProjection: AgentsProjection = {
  rows: [],
  activeCount: 0,
  hiddenHistoryCount: 0,
  totalCount: 0,
}
const FRESHNESS_TICK_MS = 1_000
const PENDING_RUN_EVENTS_LIMIT = 256

type AgentsEvents = {
  listen(listener: (event: unknown) => void): () => void
}
type FreshnessTimer = number | ReturnType<typeof window.setInterval>
type JournalEntry = { sequence: number; info: AgentRun.Info }
type SnapshotResult = {
  rootSessionID: string
  snapshot: AgentRun.Snapshot
  baseline: number
  token: object
}

function isEventSource(input: AgentsEvents | readonly AgentsEvents[]): input is AgentsEvents {
  return "listen" in input
}

export function createAgentsContext(input: {
  sessionID: () => string | undefined
  getSession: (sessionID: string) => { id: string; parentID?: string } | undefined
  queryKey: () => string
  queryClient?: QueryClient
  fetchSnapshot: (rootSessionID: string, signal?: AbortSignal) => Promise<AgentRun.Snapshot>
  events: AgentsEvents | readonly AgentsEvents[]
  initialConnectionID?: string
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => FreshnessTimer
  clearInterval?: (timer: FreshnessTimer) => void
}) {
  const rootSessionID = createMemo(() => deriveRootSessionID(input.sessionID(), input.getSession))
  const now = input.now ?? Date.now
  const [store, setStore] = createStore<{
    snapshot?: AgentRun.Snapshot
    error?: unknown
    lastSuccessAt?: number
    now: number
    showHistory: boolean
    expanded: Record<string, boolean | undefined>
    mobileDrawerOpen: boolean
    partial: boolean
  }>({ now: now(), showHistory: false, expanded: {}, mobileDrawerOpen: false, partial: false })
  let eventSequence = 0
  let evictedEventSequence = 0
  let attemptedEvictedEventSequence = 0
  let repair: { rootSessionID: string; token: object } | undefined
  let committedToken: object | undefined
  const runEvents = new Map<AgentRun.ID, JournalEntry>()
  const repairAttemptVersions = new Map<AgentRun.ID, number>()
  const queryClient = input.queryClient
  const query = createQuery(
    () => {
      const root = rootSessionID()
      return {
        queryKey: ["session-agents", input.queryKey(), root] as const,
        enabled: root !== undefined,
        queryFn: root
          ? async ({ signal }: { signal: AbortSignal }): Promise<SnapshotResult> => {
              const baseline = eventSequence
              markRepairAttempts(baseline)
              return {
                rootSessionID: root,
                snapshot: await input.fetchSnapshot(root, signal),
                baseline,
                token: {},
              }
            }
          : skipToken,
        retry: false,
        refetchInterval: false,
        refetchOnMount: true,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      }
    },
    queryClient ? () => queryClient : undefined,
  )
  const setTimer = input.setInterval ?? ((callback, ms) => window.setInterval(callback, ms))
  const clearTimer = input.clearInterval ?? ((timer) => window.clearInterval(timer))
  let timer: FreshnessTimer | undefined
  const stopTimer = () => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }
  createEffect(() => {
    if (!store.snapshot?.active.length) {
      stopTimer()
      return
    }
    if (timer !== undefined) return
    setStore("now", now())
    timer = setTimer(() => setStore("now", now()), FRESHNESS_TICK_MS)
  })
  onCleanup(stopTimer)
  const refresh = async () => {
    if (!rootSessionID()) return
    await query.refetch({ cancelRefetch: false })
  }

  function recordRunEvent(info: AgentRun.Info) {
    const sequence = ++eventSequence
    const current = runEvents.get(info.id)
    if (current && current.info.version >= info.version) return false
    runEvents.set(info.id, { sequence, info })
    if (runEvents.size <= PENDING_RUN_EVENTS_LIMIT) return true
    const oldest = runEvents.keys().next().value
    if (oldest !== undefined) {
      const evicted = runEvents.get(oldest)
      if (evicted) evictedEventSequence = Math.max(evictedEventSequence, evicted.sequence)
      runEvents.delete(oldest)
      repairAttemptVersions.delete(oldest)
    }
    return true
  }

  function knownSession(snapshot: AgentRun.Snapshot, info: AgentRun.Info) {
    return info.sessionID === snapshot.rootSessionID || snapshot.nodes.some((node) => node.sessionID === info.sessionID)
  }

  function relatedRunIDs(snapshot: AgentRun.Snapshot) {
    const sessions = new Set([snapshot.rootSessionID, ...snapshot.nodes.map((node) => node.sessionID)])
    const relevant = new Set<AgentRun.ID>()
    const entries = [...runEvents.values()]
    while (true) {
      const discovered = entries.filter(
        (entry) =>
          !relevant.has(entry.info.id) &&
          (sessions.has(entry.info.sessionID) || sessions.has(entry.info.callerSessionID)),
      )
      if (!discovered.length) return relevant
      discovered.forEach((entry) => {
        relevant.add(entry.info.id)
        sessions.add(entry.info.sessionID)
      })
    }
  }

  function unresolvedRunEvents(snapshot: AgentRun.Snapshot) {
    const relevant = relatedRunIDs(snapshot)
    return [...runEvents.values()].filter((entry) => relevant.has(entry.info.id) && !knownSession(snapshot, entry.info))
  }

  function markRepairAttempts(baseline: number) {
    if (!store.snapshot) return
    if (evictedEventSequence <= baseline) {
      attemptedEvictedEventSequence = Math.max(attemptedEvictedEventSequence, evictedEventSequence)
    }
    unresolvedRunEvents(store.snapshot).forEach((entry) => {
      if (entry.sequence > baseline) return
      repairAttemptVersions.set(
        entry.info.id,
        Math.max(repairAttemptVersions.get(entry.info.id) ?? -1, entry.info.version),
      )
    })
  }

  function ensureRepair() {
    const root = rootSessionID()
    if (!root || !store.snapshot) return
    const unresolved = unresolvedRunEvents(store.snapshot)
    if (!unresolved.length && evictedEventSequence === 0) return
    setStore("partial", true)
    if (repair?.rootSessionID === root) return
    const needsRunRepair = unresolved.some(
      (entry) => (repairAttemptVersions.get(entry.info.id) ?? -1) < entry.info.version,
    )
    if (!needsRunRepair && attemptedEvictedEventSequence >= evictedEventSequence) return
    const token = {}
    repair = { rootSessionID: root, token }
    void query
      .refetch({ cancelRefetch: false })
      .catch(() => {})
      .finally(() => {
        if (repair?.token !== token) return
        repair = undefined
        ensureRepair()
      })
  }

  function applySnapshot(result: SnapshotResult) {
    if (evictedEventSequence <= result.baseline) {
      evictedEventSequence = 0
      attemptedEvictedEventSequence = 0
    }
    const relevant = relatedRunIDs(result.snapshot)
    const next = [...runEvents.values()].reduce((snapshot, entry) => {
      if (!relevant.has(entry.info.id)) {
        runEvents.delete(entry.info.id)
        repairAttemptVersions.delete(entry.info.id)
        return snapshot
      }
      if (!knownSession(snapshot, entry.info)) return snapshot
      repairAttemptVersions.delete(entry.info.id)
      if (entry.sequence <= result.baseline && runEvents.get(entry.info.id) === entry) runEvents.delete(entry.info.id)
      return upsertAgentRun(snapshot, entry.info)
    }, result.snapshot)
    const partial = evictedEventSequence > 0 || unresolvedRunEvents(next).length > 0
    setStore({ snapshot: next, error: undefined, lastSuccessAt: now(), partial })
    if (partial) ensureRepair()
  }

  function applyRunEvent(info: AgentRun.Info) {
    if (!recordRunEvent(info) || !store.snapshot) return
    if (!relatedRunIDs(store.snapshot).has(info.id)) return
    if (!knownSession(store.snapshot, info)) {
      setStore("partial", true)
      ensureRepair()
      return
    }
    repairAttemptVersions.delete(info.id)
    const next = upsertAgentRun(store.snapshot, info)
    if (next === store.snapshot) return
    setStore("snapshot", next)
  }
  let connectionObserved = input.initialConnectionID !== undefined
  let connectionID = input.initialConnectionID
  const eventSources = isEventSource(input.events) ? [input.events] : input.events
  const stops = eventSources.map((events) =>
    events.listen((event) => {
      if (isServerConnectedEvent(event)) {
        const nextConnectionID = serverConnectedEventID(event)
        if (!connectionObserved || nextConnectionID === connectionID) {
          connectionObserved = true
          connectionID = nextConnectionID
          return
        }
        connectionID = nextConnectionID
        void refresh()
        return
      }
      const info = decodeAgentRunEvent(event)
      if (!info) return
      applyRunEvent(info)
    }),
  )
  onCleanup(() => stops.forEach((stop) => stop()))

  createEffect(
    on(
      rootSessionID,
      () => {
        batch(() => {
          setStore("snapshot", undefined)
          setStore("error", undefined)
          setStore("lastSuccessAt", undefined)
          setStore("showHistory", false)
          setStore("expanded", reconcile({}))
          setStore("mobileDrawerOpen", false)
          setStore("partial", false)
          repair = undefined
          committedToken = undefined
          eventSequence = 0
          evictedEventSequence = 0
          attemptedEvictedEventSequence = 0
          runEvents.clear()
          repairAttemptVersions.clear()
        })
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const root = rootSessionID()
    const result = query.data
    if (!root || !result || result.rootSessionID !== root || committedToken === result.token) return
    committedToken = result.token
    untrack(() => applySnapshot(result))
  })

  createEffect(() => {
    if (!query.error) return
    setStore("error", query.error)
  })

  const projection = createMemo(() => {
    if (!store.snapshot) return emptyProjection
    return projectAgents(store.snapshot, { now: store.now, showHistory: store.showHistory })
  })
  const stale = createMemo(() => store.snapshot !== undefined && store.error !== undefined)
  const warning = createMemo(() => {
    if (!stale() && !store.partial) return undefined
    return { stale: stale(), partial: store.partial }
  })
  return {
    rootSessionID,
    projection,
    snapshot: () => store.snapshot,
    loading: () => rootSessionID() !== undefined && query.isFetching,
    error: () => store.error,
    lastSuccessAt: () => store.lastSuccessAt,
    stale,
    partial: () => store.partial,
    warning,
    refresh,
    now: () => store.now,
    showHistory: () => store.showHistory,
    setShowHistory: (visible: boolean) => setStore("showHistory", visible),
    toggleShowHistory: () => setStore("showHistory", (visible) => !visible),
    expanded: (sessionID: string) => store.expanded[sessionID] ?? false,
    setExpanded: (sessionID: string, expanded: boolean) => setStore("expanded", sessionID, expanded),
    toggleExpanded: (sessionID: string) => setStore("expanded", sessionID, (expanded) => !(expanded ?? false)),
    mobileDrawerOpen: () => store.mobileDrawerOpen,
    setMobileDrawerOpen: (open: boolean) => setStore("mobileDrawerOpen", open),
    toggleMobileDrawer: () => setStore("mobileDrawerOpen", (open) => !open),
  }
}

const agentsContext = createSimpleContext({
  name: "Agents",
  init: () => {
    const params = useParams<{ id?: string }>()
    const platform = usePlatform()
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const sync = useSync()

    return createAgentsContext({
      sessionID: () => params.id,
      getSession: (sessionID) => sync().session.get(sessionID),
      queryKey: () => `${serverSDK().scope}\0${sdk().directory}`,
      fetchSnapshot: (rootSessionID, signal) =>
        fetchAgentRunSnapshot({
          server: serverSDK().server.http,
          fetch: platform.fetch ?? fetch,
          rootSessionID,
          signal,
        }),
      initialConnectionID: serverSDK().event.connectionID,
      events: [
        {
          listen(listener) {
            return sdk().event.listen((event) => listener(event.details))
          },
        },
        {
          listen(listener) {
            return serverSDK().event.on("global", listener)
          },
        },
      ],
    })
  },
})

export function useAgents() {
  return agentsContext.use()
}

export function AgentsProvider(props: Parameters<typeof agentsContext.provider>[0]) {
  return agentsContext.provider(props)
}
