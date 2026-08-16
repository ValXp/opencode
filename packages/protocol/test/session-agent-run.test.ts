import { expect, test } from "bun:test"
import { AgentRun } from "@opencode-ai/schema/agent-run"
import { Session } from "@opencode-ai/schema/session"
import { Schema, SchemaAST } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { makeDefaultApi } from "../src/api"
import { makeSessionGroup } from "../src/groups/session"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()("test/LocationMiddleware") {}

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionLocationMiddleware",
) {}

const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})
const SessionGroup = makeSessionGroup(SessionLocationMiddleware)

test("exports the agent-run endpoint from the public API", () => {
  expect(Api.groups["server.session"].endpoints["session.agentRun"]).toBeDefined()
})

test("defines the session agent-run snapshot contract", () => {
  const endpoint = SessionGroup.endpoints["session.agentRun"]

  expect(endpoint.method).toBe("GET")
  expect(endpoint.path).toBe("/api/session/:sessionID/agent-run")
  expect([...endpoint.middlewares].map((middleware) => middleware.key)).toContain(SessionLocationMiddleware.key)
  expect([...endpoint.error].map((schema) => SchemaAST.resolveIdentifier(schema.ast))).toContain("SessionNotFoundError")

  expect(endpoint.params).toBeDefined()
  if (endpoint.params === undefined) throw new Error("Expected agent-run path params")
  const params = Schema.make<Schema.Codec<unknown, unknown>>(endpoint.params.ast)
  expect(Schema.decodeUnknownSync(params)({ sessionID: "ses_contract" })).toEqual({
    sessionID: Session.ID.make("ses_contract"),
  })
  expect(() => Schema.decodeUnknownSync(params)({ sessionID: "invalid" })).toThrow()

  const snapshot = {
    rootSessionID: Session.ID.make("ses_contract"),
    nodes: [],
    active: [],
    history: [],
  }
  expect(endpoint.success.size).toBe(1)
  const success = [...endpoint.success][0]
  expect(success).toBeDefined()
  if (success === undefined) throw new Error("Expected agent-run success schema")
  expect(SchemaAST.resolveIdentifier(success.ast)).toBe(SchemaAST.resolveIdentifier(AgentRun.Snapshot.ast))
  const decodeSuccess = Schema.decodeUnknownSync(Schema.make<Schema.Codec<unknown, unknown>>(success.ast))
  expect(decodeSuccess(snapshot)).toEqual(snapshot)
  expect(() => decodeSuccess({ data: snapshot })).toThrow()
})
