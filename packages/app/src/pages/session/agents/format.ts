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

export function formatDuration(value: number, locale: string) {
  const seconds = Math.floor(Math.max(0, value))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  const format = (amount: number, unit: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(amount)
  const values = hours
    ? [format(hours, "hour"), ...(minutes ? [format(minutes, "minute")] : [])]
    : minutes
      ? [format(minutes, "minute"), ...(remainder ? [format(remainder, "second")] : [])]
      : [format(remainder, "second")]
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format(values)
}

export function formatElapsed(run: AgentRun.Info | undefined, now: number, locale: string) {
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
  const format = (value: number, unit: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(value)
  const values = hours
    ? [format(hours, "hour"), format(minutes, "minute"), format(remainder, "second")]
    : minutes
      ? [format(minutes, "minute"), format(remainder, "second")]
      : [format(remainder, "second")]
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format(values)
}
