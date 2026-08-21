import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { decodeAgentRunEvent, fetchAgentRunOverview } from "./source"

const encoded = {
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

  test("loads and decodes the server-wide agent-run overview with target-server auth", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    async function fetchOverview(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBeUndefined()
      requests.push({ input, init })
      return Response.json(encoded)
    }

    const result = await fetchAgentRunOverview({
      server: { url: "https://target.example/base", username: "agent", password: "secret" },
      fetch: fetchOverview,
    })

    const request = requests[0]?.input
    expect(request instanceof Request ? request.url : String(request)).toBe("https://target.example/api/agent-run")
    expect(requests[0]?.init?.method).toBe("GET")
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(`Basic ${btoa("agent:secret")}`)
    expect(new Headers(requests[0]?.init?.headers).has("x-opencode-directory")).toBeFalse()
    expect("rootSessionID" in result).toBeFalse()
    expect(DateTime.toEpochMillis(result.active[0].activity.at)).toBe(2_000)
  })
})
