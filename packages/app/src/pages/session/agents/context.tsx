import { AgentRun } from "@opencode-ai/schema"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createQuery, type QueryClient } from "@tanstack/solid-query"
import { batch, createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { projectAgents, type AgentsProjection, upsertAgentRun } from "./model"
import { decodeAgentRunEvent, fetchAgentRunOverview, isServerConnectedEvent, serverConnectedEventID } from "./source"

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
type OverviewResult = {
  serverKey: string
  overview: AgentRun.Overview
  baseline: number
  token: object
}

export function createAgentsContext(input: {
  queryKey: () => string
  queryClient?: QueryClient
  fetchOverview: (signal?: AbortSignal) => Promise<AgentRun.Overview>
  events: AgentsEvents
  initialConnectionID?: string
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => FreshnessTimer
  clearInterval?: (timer: FreshnessTimer) => void
}) {
  const serverKey = createMemo(input.queryKey)
  const now = input.now ?? Date.now
  const [store, setStore] = createStore<{
    overview?: AgentRun.Overview
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
  let repair: { serverKey: string; token: object } | undefined
  let committedToken: object | undefined
  const runEvents = new Map<AgentRun.ID, JournalEntry>()
  const repairAttemptVersions = new Map<AgentRun.ID, number>()
  const queryClient = input.queryClient
  const query = createQuery(
    () => {
      const key = serverKey()
      return {
        queryKey: ["agents", key] as const,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<OverviewResult> => {
          const baseline = eventSequence
          markRepairAttempts(baseline)
          return {
            serverKey: key,
            overview: await input.fetchOverview(signal),
            baseline,
            token: {},
          }
        },
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
    if (!store.overview?.active.length) {
      stopTimer()
      return
    }
    if (timer !== undefined) return
    setStore("now", now())
    timer = setTimer(() => setStore("now", now()), FRESHNESS_TICK_MS)
  })
  onCleanup(stopTimer)
  const refresh = async () => {
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

  function knownSession(overview: AgentRun.Overview, info: AgentRun.Info) {
    return overview.nodes.some((node) => node.sessionID === info.sessionID)
  }

  function unresolvedRunEvents(overview: AgentRun.Overview) {
    return [...runEvents.values()].filter((entry) => !knownSession(overview, entry.info))
  }

  function markRepairAttempts(baseline: number) {
    if (!store.overview) return
    if (evictedEventSequence <= baseline) {
      attemptedEvictedEventSequence = Math.max(attemptedEvictedEventSequence, evictedEventSequence)
    }
    unresolvedRunEvents(store.overview).forEach((entry) => {
      if (entry.sequence > baseline) return
      repairAttemptVersions.set(
        entry.info.id,
        Math.max(repairAttemptVersions.get(entry.info.id) ?? -1, entry.info.version),
      )
    })
  }

  function ensureRepair() {
    if (!store.overview) return
    const key = serverKey()
    const unresolved = unresolvedRunEvents(store.overview)
    if (!unresolved.length && evictedEventSequence === 0) return
    setStore("partial", true)
    if (repair?.serverKey === key) return
    const needsRunRepair = unresolved.some(
      (entry) => (repairAttemptVersions.get(entry.info.id) ?? -1) < entry.info.version,
    )
    if (!needsRunRepair && attemptedEvictedEventSequence >= evictedEventSequence) return
    const token = {}
    repair = { serverKey: key, token }
    void query
      .refetch({ cancelRefetch: false })
      .catch(() => {})
      .finally(() => {
        if (repair?.token !== token) return
        repair = undefined
        ensureRepair()
      })
  }

  function applyOverview(result: OverviewResult) {
    if (evictedEventSequence <= result.baseline) {
      evictedEventSequence = 0
      attemptedEvictedEventSequence = 0
    }
    const next = [...runEvents.values()].reduce((overview, entry) => {
      if (!knownSession(overview, entry.info)) return overview
      repairAttemptVersions.delete(entry.info.id)
      if (entry.sequence <= result.baseline && runEvents.get(entry.info.id) === entry) runEvents.delete(entry.info.id)
      return upsertAgentRun(overview, entry.info)
    }, result.overview)
    const partial = evictedEventSequence > 0 || unresolvedRunEvents(next).length > 0
    setStore({ overview: next, error: undefined, lastSuccessAt: now(), partial })
    if (partial) ensureRepair()
  }

  function applyRunEvent(info: AgentRun.Info) {
    if (!recordRunEvent(info) || !store.overview) return
    if (!knownSession(store.overview, info)) {
      setStore("partial", true)
      ensureRepair()
      return
    }
    repairAttemptVersions.delete(info.id)
    const next = upsertAgentRun(store.overview, info)
    if (next === store.overview) return
    setStore("overview", next)
  }
  let connectionObserved = input.initialConnectionID !== undefined
  let connectionID = input.initialConnectionID
  const stop = input.events.listen((event) => {
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
  })
  onCleanup(stop)

  createEffect(
    on(
      serverKey,
      () => {
        batch(() => {
          setStore("overview", undefined)
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
    const key = serverKey()
    const result = query.data
    if (!result || result.serverKey !== key || committedToken === result.token) return
    committedToken = result.token
    untrack(() => applyOverview(result))
  })

  createEffect(() => {
    if (!query.error) return
    setStore("error", query.error)
  })

  const projection = createMemo(() => {
    if (!store.overview) return emptyProjection
    return projectAgents(store.overview, { now: store.now, showHistory: store.showHistory })
  })
  const stale = createMemo(() => store.overview !== undefined && store.error !== undefined)
  const warning = createMemo(() => {
    if (!stale() && !store.partial) return undefined
    return { stale: stale(), partial: store.partial }
  })
  return {
    projection,
    overview: () => store.overview,
    loading: () => query.isFetching,
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
    const platform = usePlatform()
    const serverSDK = useServerSDK()

    return createAgentsContext({
      queryKey: () => serverSDK().scope,
      fetchOverview: (signal) =>
        fetchAgentRunOverview({
          server: serverSDK().server.http,
          fetch: platform.fetch ?? fetch,
          signal,
        }),
      initialConnectionID: serverSDK().event.connectionID,
      events: {
        listen(listener) {
          return serverSDK().event.listen((event) => listener(event.details))
        },
      },
    })
  },
})

export function useAgents() {
  return agentsContext.use()
}

export function AgentsProvider(props: Parameters<typeof agentsContext.provider>[0]) {
  return agentsContext.provider(props)
}
