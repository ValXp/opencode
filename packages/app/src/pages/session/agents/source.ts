import { AgentRun } from "@opencode-ai/schema"
import { DateTime, Option, Schema } from "effect"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

const decodeOverview = Schema.decodeUnknownPromise(AgentRun.Overview)
const decodeInfo = Schema.decodeUnknownOption(AgentRun.Info)

type AgentRunFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function decodeAgentRunEvent(event: unknown): AgentRun.Info | undefined {
  if (!record(event) || event.type !== "agent.run.updated") return undefined
  if (!record(event.properties)) return undefined
  const decoded = decodeInfo(event.properties.info)
  if (Option.isSome(decoded)) return decoded.value
  if (!record(event.properties.info)) return undefined
  const info = event.properties.info
  if (!record(info.activity) || !record(info.time)) return undefined
  const state =
    record(info.state) && info.state.type === "retrying"
      ? { ...info.state, next: timestampMillis(info.state.next) }
      : info.state
  return Option.getOrUndefined(
    decodeInfo({
      ...info,
      state,
      activity: { ...info.activity, at: timestampMillis(info.activity.at) },
      time: {
        ...info.time,
        created: timestampMillis(info.time.created),
        updated: timestampMillis(info.time.updated),
        ...(info.time.started === undefined ? {} : { started: timestampMillis(info.time.started) }),
        ...(info.time.finished === undefined ? {} : { finished: timestampMillis(info.time.finished) }),
      },
    }),
  )
}

function timestampMillis(value: unknown) {
  if (typeof value !== "string") return value
  const result = DateTime.make(value)
  return Option.isSome(result) ? DateTime.toEpochMillis(result.value) : value
}

export function isServerConnectedEvent(event: unknown) {
  return record(event) && event.type === "server.connected"
}

export function serverConnectedEventID(event: unknown) {
  if (!isServerConnectedEvent(event) || !record(event)) return undefined
  return typeof event.id === "string" ? event.id : undefined
}

export async function fetchAgentRunOverview(input: {
  server: ServerConnection.HttpBase
  fetch: AgentRunFetch
  signal?: AbortSignal
}) {
  const fetchOverview = input.fetch
  const response = await fetchOverview(new URL("/api/agent-run", input.server.url), {
    method: "GET",
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`Failed to load agent runs: ${response.status} ${response.statusText}`.trim())
  return decodeOverview(await response.json())
}
