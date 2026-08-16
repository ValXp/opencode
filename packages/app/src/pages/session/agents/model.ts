import type { AgentRun } from "@opencode-ai/schema"
import { DateTime } from "effect"

type SessionID = AgentRun.Snapshot["rootSessionID"]
const INACTIVE_AFTER_MS = 60_000

export interface AgentRow {
  readonly node: AgentRun.Node
  readonly depth: number
  readonly runs: readonly AgentRun.Info[]
  readonly current: AgentRun.Info | undefined
  readonly state: AgentRun.State | undefined
  readonly active: boolean
  readonly resumeCount: number
  readonly contextOnly: boolean
  readonly freshness:
    | {
        readonly at: AgentRun.Info["activity"]["at"]
        readonly ageMs: number
        readonly inactive: boolean
      }
    | undefined
}

export interface AgentsProjection {
  readonly rows: readonly AgentRow[]
  readonly activeCount: number
  readonly hiddenHistoryCount: number
  readonly totalCount: number
}

export interface ProjectAgentsOptions {
  readonly now: number
  readonly showHistory?: boolean
  readonly inactiveAfterMs?: number
}

export function projectAgents(snapshot: AgentRun.Snapshot, options: ProjectAgentsOptions): AgentsProjection {
  const runsBySession = new Map<SessionID, AgentRun.Info[]>()
  snapshot.active.concat(snapshot.history).forEach((run) => {
    const runs = runsBySession.get(run.sessionID) ?? []
    runs.push(run)
    runsBySession.set(run.sessionID, runs)
  })
  runsBySession.forEach((runs, sessionID) => runsBySession.set(sessionID, orderRuns(runs)))
  const forest = buildForest(snapshot)
  const currentBySession = new Map(
    [...runsBySession].flatMap(([sessionID, runs]) => {
      const current = selectCurrentRun(runs)
      return current ? [[sessionID, current] as const] : []
    }),
  )
  const currentRuns = [...currentBySession.values()].filter((run) => forest.nodes.has(run.sessionID))
  const selected = new Set(
    currentRuns
      .filter((run) => run.state.type === "running" || run.state.type === "retrying")
      .map((run) => run.sessionID),
  )
  const terminal = currentRuns
    .filter((run) => run.state.type !== "running" && run.state.type !== "retrying")
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(b.time.finished ?? b.time.updated) -
          DateTime.toEpochMillis(a.time.finished ?? a.time.updated) || compare(a.sessionID, b.sessionID),
    )
  terminal.slice(0, options.showHistory ? terminal.length : 10).forEach((run) => selected.add(run.sessionID))

  const context = new Set<SessionID>()
  const includeAncestors = (sessionID: SessionID, seen: Set<SessionID>) => {
    const parentSessionID = forest.parents.get(sessionID)
    if (!parentSessionID || parentSessionID === snapshot.rootSessionID || seen.has(parentSessionID)) return
    seen.add(parentSessionID)
    context.add(parentSessionID)
    includeAncestors(parentSessionID, seen)
  }
  selected.forEach((sessionID) => {
    includeAncestors(sessionID, new Set([sessionID]))
  })

  const rows: AgentRow[] = []
  const visited = new Set<SessionID>()
  const visit = (parentSessionID: SessionID, depth: number) => {
    forest.children.get(parentSessionID)?.forEach((node) => {
      if (visited.has(node.sessionID)) return
      visited.add(node.sessionID)
      const runs = runsBySession.get(node.sessionID)
      if (selected.has(node.sessionID) || context.has(node.sessionID)) {
        const current = currentBySession.get(node.sessionID)
        const active = current?.state.type === "running" || current?.state.type === "retrying"
        rows.push({
          node,
          depth,
          runs: runs ?? [],
          current,
          state: current?.state,
          active,
          resumeCount: Math.max(0, (runs?.length ?? 0) - 1),
          contextOnly: !selected.has(node.sessionID),
          freshness: current ? getFreshness(current, options) : undefined,
        })
      }
      visit(node.sessionID, depth + 1)
    })
  }
  visit(snapshot.rootSessionID, 0)

  return {
    rows,
    activeCount: rows.filter((row) => row.active).length,
    hiddenHistoryCount: Math.max(0, terminal.length - 10),
    totalCount: currentRuns.length,
  }
}

export function upsertAgentRun(snapshot: AgentRun.Snapshot, info: AgentRun.Info): AgentRun.Snapshot {
  const runs = snapshot.active.concat(snapshot.history)
  const existing = runs.filter((run) => run.id === info.id).sort((a, b) => b.version - a.version)[0]
  if (existing && existing.version >= info.version) return snapshot

  const sessionRuns = orderRuns([...runs.filter((run) => run.id !== info.id && run.sessionID === info.sessionID), info])
  const active = snapshot.active.filter((run) => run.id !== info.id && run.sessionID !== info.sessionID)
  const history = snapshot.history.filter((run) => run.id !== info.id && run.sessionID !== info.sessionID)
  const current = sessionRuns[0]
  if (current.state.type === "running" || current.state.type === "retrying") {
    return { ...snapshot, active: [...active, current], history: [...history, ...sessionRuns.slice(1)] }
  }
  return { ...snapshot, active, history: [...history, ...sessionRuns] }
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareNodes(a: AgentRun.Node, b: AgentRun.Node) {
  return (
    DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
    compare(a.sessionID, b.sessionID) ||
    compare(a.parentSessionID, b.parentSessionID) ||
    compare(a.title, b.title)
  )
}

function buildForest(snapshot: AgentRun.Snapshot) {
  const ordered = snapshot.nodes
    .filter((node) => node.sessionID !== snapshot.rootSessionID)
    .slice()
    .sort(compareNodes)
  const nodes = new Map<SessionID, AgentRun.Node>()
  ordered.forEach((node) => {
    if (!nodes.has(node.sessionID)) nodes.set(node.sessionID, node)
  })
  const parents = new Map<SessionID, SessionID>(
    [...nodes.values()].map((node) => [
      node.sessionID,
      node.parentSessionID === snapshot.rootSessionID || nodes.has(node.parentSessionID)
        ? node.parentSessionID
        : snapshot.rootSessionID,
    ]),
  )
  const breakCycle = (start: SessionID) => {
    const path: SessionID[] = []
    const positions = new Map<SessionID, number>()
    const visit = (sessionID: SessionID): void => {
      if (sessionID === snapshot.rootSessionID) return
      const position = positions.get(sessionID)
      if (position !== undefined) {
        const root = path
          .slice(position)
          .map((id) => nodes.get(id))
          .filter((node): node is AgentRun.Node => node !== undefined)
          .sort(compareNodes)[0]
        if (root) parents.set(root.sessionID, snapshot.rootSessionID)
        return
      }
      const parentSessionID = parents.get(sessionID)
      if (!parentSessionID) return
      positions.set(sessionID, path.length)
      path.push(sessionID)
      visit(parentSessionID)
    }
    visit(start)
  }
  Array.from(nodes.keys()).forEach(breakCycle)

  const children = new Map<SessionID, AgentRun.Node[]>()
  nodes.forEach((node) => {
    const parentSessionID = parents.get(node.sessionID) ?? snapshot.rootSessionID
    const siblings = children.get(parentSessionID) ?? []
    siblings.push(node)
    children.set(parentSessionID, siblings)
  })
  children.forEach((siblings) => siblings.sort(compareNodes))
  return { children, nodes, parents }
}

function getFreshness(run: AgentRun.Info, options: ProjectAgentsOptions) {
  const activityAt = DateTime.toEpochMillis(run.activity.at)
  const at =
    run.time.started && DateTime.toEpochMillis(run.time.started) > activityAt ? run.time.started : run.activity.at
  const ageMs = Math.max(0, options.now - DateTime.toEpochMillis(at))
  return {
    at,
    ageMs,
    inactive:
      (run.state.type === "running" || run.state.type === "retrying") &&
      run.time.started !== undefined &&
      ageMs >= (options.inactiveAfterMs ?? INACTIVE_AFTER_MS),
  }
}

function orderRuns(runs: AgentRun.Info[]) {
  const byID = new Map<AgentRun.ID, AgentRun.Info>()
  runs.forEach((run) => {
    const current = byID.get(run.id)
    if (!current || run.version > current.version) byID.set(run.id, run)
  })
  const unique = [...byID.values()]
  const referenced = new Set(
    unique.flatMap((run) => (run.previousRunID && byID.has(run.previousRunID) ? [run.previousRunID] : [])),
  )
  const byRecency = (a: AgentRun.Info, b: AgentRun.Info) =>
    DateTime.toEpochMillis(b.time.created) - DateTime.toEpochMillis(a.time.created) || compare(b.id, a.id)
  const ordered: AgentRun.Info[] = []
  const visited = new Set<AgentRun.ID>()
  const visit = (run: AgentRun.Info | undefined) => {
    if (!run || visited.has(run.id)) return
    visited.add(run.id)
    ordered.push(run)
    visit(run.previousRunID ? byID.get(run.previousRunID) : undefined)
  }

  unique
    .filter((run) => !referenced.has(run.id))
    .sort(byRecency)
    .forEach(visit)
  unique.slice().sort(byRecency).forEach(visit)
  return ordered
}

function selectCurrentRun(runs: readonly AgentRun.Info[]) {
  const newest = runs[0]
  if (!newest || newest.time.started || (newest.state.type !== "running" && newest.state.type !== "retrying")) {
    return newest
  }
  const byID = new Map(runs.map((run) => [run.id, run]))
  const visited = new Set<AgentRun.ID>([newest.id])
  const executingPredecessor = (run: AgentRun.Info): AgentRun.Info | undefined => {
    const previous = run.previousRunID && !visited.has(run.previousRunID) ? byID.get(run.previousRunID) : undefined
    if (!previous || (previous.state.type !== "running" && previous.state.type !== "retrying")) return undefined
    visited.add(previous.id)
    return previous.time.started ? previous : executingPredecessor(previous)
  }
  return executingPredecessor(newest) ?? newest
}
