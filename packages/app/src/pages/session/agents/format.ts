import type { AgentRun, Session } from "@opencode-ai/schema"
import { DateTime } from "effect"

type Timestamp = AgentRun.Info["time"]["created"]

export interface AgentSessionUsage {
  readonly cost?: Session.Info["cost"]
  readonly tokens?: Session.Info["tokens"]
}

export function formatTimestamp(value: Timestamp, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(
    DateTime.toEpochMillis(value),
  )
}

export function timestampISOString(value: Timestamp) {
  return new Date(DateTime.toEpochMillis(value)).toISOString()
}

export function formatElapsed(run: AgentRun.Info | undefined, now: number) {
  if (!run) return undefined
  const start = DateTime.toEpochMillis(run.time.started ?? run.time.created)
  const end = run.time.finished
    ? DateTime.toEpochMillis(run.time.finished)
    : run.state.type === "running" || run.state.type === "retrying"
      ? now
      : DateTime.toEpochMillis(run.time.updated)
  const seconds = Math.floor(Math.max(0, end - start) / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (hours) return `${hours}h ${minutes}m ${remainder}s`
  if (minutes) return `${minutes}m ${remainder}s`
  return `${remainder}s`
}
