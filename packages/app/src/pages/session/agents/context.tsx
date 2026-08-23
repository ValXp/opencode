import { AgentRun } from "@opencode-ai/schema"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams } from "@solidjs/router"
import { createQuery, type QueryClient, skipToken } from "@tanstack/solid-query"
import { batch, createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { projectAgents, type AgentsProjection, upsertAgentRun } from "./model"
import {
  decodeAgentRunEvent,
  fetchAgentRunOverview,
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
type Journal = {
  events: Map<AgentRun.ID, JournalEntry>
  evictedSequence: number
  attemptedEvictedSequence: number
  repairAttempts: Map<AgentRun.ID, number>
}
type AgentRunView = AgentRun.Overview | AgentRun.Snapshot
type OverviewResult<T extends AgentRunView> = {
  queryKey: string
  overview: T
  baseline: number
  token: object
}
type AgentsContextOptions = {
  queryClient?: QueryClient
  events: AgentsEvents
  initialConnectionID?: string
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => FreshnessTimer
  clearInterval?: (timer: FreshnessTimer) => void
}

export function createAgentsContext(
  input: AgentsContextOptions & {
    queryKey: () => string
    fetchOverview: (signal?: AbortSignal) => Promise<AgentRun.Overview>
  },
) {
  return createAgentRunContext({
    ...input,
    queryPrefix: "agents",
    scope: input.queryKey,
    queryKey: (scope) => scope,
    fetchOverview: (_, signal) => input.fetchOverview(signal),
  })
}

export function createSessionAgentsContext(
  input: AgentsContextOptions & {
    rootSessionID: () => string | undefined
    queryKey: () => string
    fetchSnapshot: (rootSessionID: string, signal?: AbortSignal) => Promise<AgentRun.Snapshot>
  },
) {
  return createAgentRunContext({
    ...input,
    queryPrefix: "session-agents",
    scope: input.rootSessionID,
    queryKey: (rootSessionID) => `${input.queryKey()}\0${rootSessionID}`,
    fetchOverview: input.fetchSnapshot,
  })
}

function createAgentRunContext<T extends AgentRunView>(
  input: AgentsContextOptions & {
    queryPrefix: "agents" | "session-agents"
    scope: () => string | undefined
    queryKey: (scope: string) => string
    fetchOverview: (scope: string, signal?: AbortSignal) => Promise<T>
  },
) {
  const request = createMemo(() => {
    const scope = input.scope()
    if (!scope) return
    return { scope, queryKey: input.queryKey(scope) }
  })
  const queryKey = createMemo(() => request()?.queryKey)
  const now = input.now ?? Date.now
  const [store, setStore] = createStore<{
    queryKey?: string
    overview?: T
    error?: unknown
    lastSuccessAt?: number
    now: number
    showHistory: boolean
    expanded: Record<string, boolean | undefined>
    mobileDrawerOpen: boolean
    partial: boolean
  }>({ now: now(), showHistory: false, expanded: {}, mobileDrawerOpen: false, partial: false })
  let eventSequence = 0
  let repair: { queryKey: string; token: object } | undefined
  let committedToken: object | undefined
  const journals = new Map<string, Journal>()
  const queryClient = input.queryClient
  const query = createQuery(
    () => {
      const current = request()
      return {
        queryKey: [input.queryPrefix, current?.queryKey] as const,
        enabled: current !== undefined,
        queryFn: current
          ? async ({ signal }: { signal: AbortSignal }): Promise<OverviewResult<T>> => {
              const baseline = eventSequence
              markRepairAttempts(baseline)
              return {
                queryKey: current.queryKey,
                overview: await input.fetchOverview(current.scope, signal),
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
    if (!request()) return
    await query.refetch({ cancelRefetch: false })
  }

  function getJournal(key: string) {
    const current = journals.get(key)
    if (current) return current
    const next: Journal = {
      events: new Map(),
      evictedSequence: 0,
      attemptedEvictedSequence: 0,
      repairAttempts: new Map(),
    }
    journals.set(key, next)
    return next
  }

  function recordRunEvent(info: AgentRun.Info) {
    const key = queryKey()
    if (!key) return
    const journal = getJournal(key)
    const sequence = ++eventSequence
    const current = journal.events.get(info.id)
    if (current && current.info.version >= info.version) return
    journal.events.set(info.id, { sequence, info })
    if (journal.events.size <= PENDING_RUN_EVENTS_LIMIT) return key
    const oldest = journal.events.keys().next().value
    if (oldest !== undefined) {
      const evicted = journal.events.get(oldest)
      if (evicted) journal.evictedSequence = Math.max(journal.evictedSequence, evicted.sequence)
      journal.events.delete(oldest)
      journal.repairAttempts.delete(oldest)
    }
    return key
  }

  function knownSession(overview: T, info: AgentRun.Info) {
    return (
      ("rootSessionID" in overview && overview.rootSessionID === info.sessionID) ||
      overview.nodes.some((node) => node.sessionID === info.sessionID)
    )
  }

  function relatedRunIDs(overview: T, key: string) {
    const events = journals.get(key)?.events
    if (!events) return new Set<AgentRun.ID>()
    if (!("rootSessionID" in overview)) return new Set(events.keys())
    const sessions = new Set([overview.rootSessionID, ...overview.nodes.map((node) => node.sessionID)])
    const relevant = new Set<AgentRun.ID>()
    const entries = [...events.values()]
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

  function unresolvedRunEvents(overview: T, key: string) {
    const relevant = relatedRunIDs(overview, key)
    return [...(journals.get(key)?.events.values() ?? [])].filter(
      (entry) => relevant.has(entry.info.id) && !knownSession(overview, entry.info),
    )
  }

  function markRepairAttempts(baseline: number) {
    const key = queryKey()
    if (!key || !store.overview || store.queryKey !== key) return
    const journal = getJournal(key)
    if (journal.evictedSequence <= baseline)
      journal.attemptedEvictedSequence = Math.max(journal.attemptedEvictedSequence, journal.evictedSequence)
    unresolvedRunEvents(store.overview, key).forEach((entry) => {
      if (entry.sequence > baseline) return
      journal.repairAttempts.set(
        entry.info.id,
        Math.max(journal.repairAttempts.get(entry.info.id) ?? -1, entry.info.version),
      )
    })
  }

  function ensureRepair() {
    const key = queryKey()
    if (!key || !store.overview || store.queryKey !== key) return
    const journal = getJournal(key)
    const unresolved = unresolvedRunEvents(store.overview, key)
    if (!unresolved.length && journal.evictedSequence === 0) return
    setStore("partial", true)
    if (repair?.queryKey === key) return
    const needsRunRepair = unresolved.some(
      (entry) => (journal.repairAttempts.get(entry.info.id) ?? -1) < entry.info.version,
    )
    if (!needsRunRepair && journal.attemptedEvictedSequence >= journal.evictedSequence) return
    const token = {}
    repair = { queryKey: key, token }
    void query
      .refetch({ cancelRefetch: false })
      .catch(() => {})
      .finally(() => {
        if (repair?.token !== token) return
        repair = undefined
        ensureRepair()
      })
  }

  function applyOverview(result: OverviewResult<T>) {
    const journal = getJournal(result.queryKey)
    if (journal.evictedSequence <= result.baseline) {
      journal.evictedSequence = 0
      journal.attemptedEvictedSequence = 0
    }
    const relevant = relatedRunIDs(result.overview, result.queryKey)
    const next = [...journal.events.values()].reduce((overview, entry) => {
      if (!relevant.has(entry.info.id)) {
        journal.events.delete(entry.info.id)
        journal.repairAttempts.delete(entry.info.id)
        return overview
      }
      if (!knownSession(overview, entry.info)) return overview
      journal.repairAttempts.delete(entry.info.id)
      if (entry.sequence <= result.baseline && journal.events.get(entry.info.id) === entry)
        journal.events.delete(entry.info.id)
      return upsertAgentRun(overview, entry.info)
    }, result.overview)
    const partial =
      journal.evictedSequence > 0 || unresolvedRunEvents(next, result.queryKey).length > 0
    setStore({ queryKey: result.queryKey, overview: next, error: undefined, lastSuccessAt: now(), partial })
    if (partial) ensureRepair()
  }

  function applyRunEvent(info: AgentRun.Info) {
    const key = recordRunEvent(info)
    if (!key || !store.overview || store.queryKey !== key) return
    if (!relatedRunIDs(store.overview, key).has(info.id)) return
    if (!knownSession(store.overview, info)) {
      setStore("partial", true)
      ensureRepair()
      return
    }
    getJournal(key).repairAttempts.delete(info.id)
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
      queryKey,
      (key) => {
        batch(() => {
          setStore("queryKey", undefined)
          setStore("overview", undefined)
          setStore("error", undefined)
          setStore("lastSuccessAt", undefined)
          setStore("showHistory", false)
          setStore("expanded", reconcile({}))
          setStore("mobileDrawerOpen", false)
          setStore("partial", false)
          repair = undefined
          committedToken = undefined
          journals.forEach((_, candidate) => {
            if (candidate !== key) journals.delete(candidate)
          })
        })
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const key = queryKey()
    const result = query.data
    if (!key || !result || result.queryKey !== key || committedToken === result.token) return
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
    loading: () => request() !== undefined && query.isFetching,
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
    const serverSync = useServerSync()
    const [lineage, setLineage] = createStore<{
      sessionID?: string
      rootSessionID?: string
      loading: boolean
      error?: unknown
    }>({ loading: false })
    let lineageToken: object | undefined
    const events = {
      listen(listener: (event: unknown) => void) {
        return serverSDK().event.listen((event) => listener(event.details))
      },
    }

    const agents = createAgentsContext({
      queryKey: () => serverSDK().scope,
      fetchOverview: (signal) =>
        fetchAgentRunOverview({
          server: serverSDK().server.http,
          fetch: platform.fetch ?? fetch,
          signal,
        }),
      initialConnectionID: serverSDK().event.connectionID,
      events,
    })
    const resolveLineage = () => {
      const sessionID = params.id
      const token = {}
      lineageToken = token
      if (!sessionID) {
        setLineage({ sessionID: undefined, rootSessionID: undefined, loading: false, error: undefined })
        return Promise.resolve()
      }
      const cached = serverSync().session.lineage.peek(sessionID)
      if (cached) {
        setLineage({ sessionID, rootSessionID: cached.root.id, loading: false, error: undefined })
        return Promise.resolve()
      }
      setLineage({ sessionID, rootSessionID: undefined, loading: true, error: undefined })
      return serverSync()
        .session.lineage.resolve(sessionID)
        .then((result) => {
          if (lineageToken !== token) return
          setLineage({ sessionID, rootSessionID: result.root.id, loading: false, error: undefined })
        })
        .catch((error) => {
          if (lineageToken !== token) return
          setLineage({ sessionID, rootSessionID: undefined, loading: false, error })
        })
    }
    createEffect(on(() => params.id, () => void resolveLineage()))
    onCleanup(() => {
      lineageToken = undefined
    })
    const scoped = createSessionAgentsContext({
      rootSessionID: () => (lineage.sessionID === params.id ? lineage.rootSessionID : undefined),
      queryKey: () => `${serverSDK().scope}\0${sdk().directory}`,
      fetchSnapshot: (rootSessionID, signal) =>
        fetchAgentRunSnapshot({
          server: serverSDK().server.http,
          fetch: platform.fetch ?? fetch,
          rootSessionID,
          signal,
        }),
      initialConnectionID: serverSDK().event.connectionID,
      events,
    })
    const session = {
      ...scoped,
      loading: () => {
        if (params.id && lineage.sessionID !== params.id) return true
        return lineage.loading || scoped.loading()
      },
      error: () => (lineage.sessionID === params.id ? lineage.error : undefined) ?? scoped.error(),
      refresh: async () => {
        if (lineage.sessionID !== params.id || !lineage.rootSessionID) {
          await resolveLineage()
          return
        }
        await scoped.refresh()
      },
    }
    return { ...agents, session }
  },
})

export function useAgents() {
  return agentsContext.use()
}

export function AgentsProvider(props: Parameters<typeof agentsContext.provider>[0]) {
  return agentsContext.provider(props)
}
