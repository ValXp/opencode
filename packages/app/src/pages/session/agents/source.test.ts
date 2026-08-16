import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { decodeAgentRunEvent, deriveRootSessionID, fetchAgentRunSnapshot } from "./source"

const encoded = {
  rootSessionID: "ses_root",
  nodes: [
    {
      sessionID: "ses_child",
      parentSessionID: "ses_root",
      title: "Child",
      createdAt: 1_000,
    },
  ],
  active: [
    {
      id: "arun_child",
      sessionID: "ses_child",
      callerSessionID: "ses_root",
      source: { messageID: "msg_child", callID: "call_child" },
      agent: "build",
      description: "Build the child",
      background: true,
      state: { type: "running" },
      activity: { at: 2_000 },
      time: { created: 1_000, updated: 2_000 },
      version: 1,
    },
  ],
  history: [],
}

describe("agent run source", () => {
  test("decodes live event timestamps serialized by the global event stream", () => {
    const info = encoded.active[0]
    const result = decodeAgentRunEvent({
      type: "agent.run.updated",
      properties: {
        info: {
          ...info,
          state: { type: "succeeded" },
          activity: { ...info.activity, at: "2026-08-12T03:43:58.532Z" },
          time: {
            created: "2026-08-12T03:27:26.929Z",
            started: "2026-08-12T03:33:51.145Z",
            updated: "2026-08-12T03:43:58.541Z",
            finished: "2026-08-12T03:44:01.123Z",
          },
        },
      },
    })

    expect(DateTime.toEpochMillis(result!.activity.at)).toBe(Date.parse("2026-08-12T03:43:58.532Z"))
    expect(DateTime.toEpochMillis(result!.time.created)).toBe(Date.parse("2026-08-12T03:27:26.929Z"))
    expect(DateTime.toEpochMillis(result!.time.started!)).toBe(Date.parse("2026-08-12T03:33:51.145Z"))
    expect(DateTime.toEpochMillis(result!.time.updated)).toBe(Date.parse("2026-08-12T03:43:58.541Z"))
    expect(DateTime.toEpochMillis(result!.time.finished!)).toBe(Date.parse("2026-08-12T03:44:01.123Z"))
  })

  test("decodes retry timestamps serialized by the global event stream", () => {
    const info = encoded.active[0]
    const result = decodeAgentRunEvent({
      type: "agent.run.updated",
      properties: {
        info: {
          ...info,
          state: {
            type: "retrying",
            attempt: 2,
            message: "Rate limited",
            next: "2026-08-12T03:44:58.532Z",
          },
          activity: { ...info.activity, at: "2026-08-12T03:43:58.532Z" },
          time: {
            created: "2026-08-12T03:27:26.929Z",
            updated: "2026-08-12T03:43:58.541Z",
          },
        },
      },
    })

    expect(result?.state.type).toBe("retrying")
    if (result?.state.type !== "retrying") throw new Error("Expected retrying agent run")
    expect(DateTime.toEpochMillis(result.state.next)).toBe(Date.parse("2026-08-12T03:44:58.532Z"))
  })

  test("rejects malformed live event timestamps", () => {
    const info = encoded.active[0]
    expect(
      decodeAgentRunEvent({
        type: "agent.run.updated",
        properties: { info: { ...info, activity: { ...info.activity, at: "not-a-timestamp" } } },
      }),
    ).toBeUndefined()
  })

  test("loads and decodes the current agent-run endpoint with target-server auth", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    async function fetchSnapshot(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBeUndefined()
      requests.push({ input, init })
      return Response.json(encoded)
    }

    const result = await fetchAgentRunSnapshot({
      server: { url: "https://target.example/base", username: "agent", password: "secret" },
      fetch: fetchSnapshot,
      rootSessionID: "ses_root",
    })

    const request = requests[0]?.input
    expect(request instanceof Request ? request.url : String(request)).toBe(
      "https://target.example/api/session/ses_root/agent-run",
    )
    expect(requests[0]?.init?.method).toBe("GET")
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(`Basic ${btoa("agent:secret")}`)
    expect(new Headers(requests[0]?.init?.headers).has("x-opencode-directory")).toBeFalse()
    expect(String(result.rootSessionID)).toBe("ses_root")
    expect(DateTime.toEpochMillis(result.active[0].activity.at)).toBe(2_000)
  })

  test("derives the highest known parent and a deterministic safe cycle ID", () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      ses_leaf: { id: "ses_leaf", parentID: "ses_child" },
      ses_child: { id: "ses_child", parentID: "ses_root" },
      ses_root: { id: "ses_root" },
      ses_missing_leaf: { id: "ses_missing_leaf", parentID: "ses_not_loaded" },
      ses_partial_leaf: { id: "ses_partial_leaf", parentID: "ses_partial_child" },
      ses_partial_child: { id: "ses_partial_child", parentID: "ses_missing_root" },
      ses_cycle_a: { id: "ses_cycle_a", parentID: "ses_cycle_b" },
      ses_cycle_b: { id: "ses_cycle_b", parentID: "ses_cycle_a" },
      ses_self_cycle: { id: "ses_self_cycle", parentID: "ses_self_cycle" },
    }
    const get = (sessionID: string) => sessions[sessionID]

    expect(deriveRootSessionID("ses_leaf", get)).toBe("ses_root")
    expect(deriveRootSessionID("ses_missing_leaf", get)).toBe("ses_not_loaded")
    expect(deriveRootSessionID("ses_partial_leaf", get)).toBe("ses_missing_root")
    expect(deriveRootSessionID("ses_cycle_a", get)).toBe("ses_cycle_a")
    expect(deriveRootSessionID("ses_cycle_b", get)).toBe("ses_cycle_a")
    expect(deriveRootSessionID("ses_self_cycle", get)).toBe("ses_self_cycle")
    expect(deriveRootSessionID("ses_not_loaded", get)).toBeUndefined()
  })
})
