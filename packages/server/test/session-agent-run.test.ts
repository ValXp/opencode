import { afterAll, expect, test } from "bun:test"
import { AgentRun } from "@opencode-ai/core/agent-run"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { makeSessionGroup } from "@opencode-ai/protocol/groups/session"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "../src/auth"
import { SessionHandler } from "../src/handlers/session"
import { authorizationLayer } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { SessionLocationMiddleware, sessionLocationLayer } from "../src/middleware/session-location"

const rootSessionID = SessionV2.ID.make("ses_agent_run_handler_root")
const childSessionID = SessionV2.ID.make("ses_agent_run_handler_child")
const grandchildSessionID = SessionV2.ID.make("ses_agent_run_handler_grandchild")
const secondRootSessionID = SessionV2.ID.make("ses_agent_run_handler_second_root")
const secondChildSessionID = SessionV2.ID.make("ses_agent_run_handler_second_child")
const missingSessionID = SessionV2.ID.make("ses_agent_run_handler_missing")
const fixture: {
  snapshot?: typeof AgentRun.Snapshot.Encoded
  overview?: typeof AgentRun.Overview.Encoded
} = {}

const services = AppNodeBuilder.build(
  LayerNode.group([Database.node, AgentRun.node, SessionV2.node, LocationServiceMap.node]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [SessionExecution.node, SessionExecution.noopLayer],
  ],
)

const seed = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runs = yield* AgentRun.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values([
        {
          id: rootSessionID,
          project_id: ProjectV2.ID.global,
          slug: "root",
          directory: "/tmp",
          title: "Root",
          version: "test",
          time_created: 1,
          time_updated: 1,
        },
        {
          id: childSessionID,
          project_id: ProjectV2.ID.global,
          parent_id: rootSessionID,
          slug: "child",
          directory: "/tmp",
          title: "Child",
          agent: "review",
          version: "test",
          time_created: 2,
          time_updated: 2,
        },
        {
          id: grandchildSessionID,
          project_id: ProjectV2.ID.global,
          parent_id: childSessionID,
          slug: "grandchild",
          directory: "/tmp",
          title: "Grandchild",
          agent: "build",
          version: "test",
          time_created: 3,
          time_updated: 3,
        },
        {
          id: secondRootSessionID,
          project_id: ProjectV2.ID.global,
          slug: "second-root",
          directory: "/tmp",
          title: "Second root",
          version: "test",
          time_created: 4,
          time_updated: 4,
        },
        {
          id: secondChildSessionID,
          project_id: ProjectV2.ID.global,
          parent_id: secondRootSessionID,
          slug: "second-child",
          directory: "/tmp",
          title: "Second child",
          agent: "review",
          version: "test",
          time_created: 5,
          time_updated: 5,
        },
      ])
      .run()
      .pipe(Effect.orDie)

    yield* runs.admit({
      sessionID: childSessionID,
      callerSessionID: rootSessionID,
      source: { messageID: SessionMessage.ID.make("msg_agent_run_handler_active"), callID: "active" },
      agent: AgentV2.ID.make("review"),
      description: "Review the handler",
      background: true,
      ownerID: "test-process",
    })
    const terminal = yield* runs.admit({
      sessionID: grandchildSessionID,
      callerSessionID: childSessionID,
      source: { messageID: SessionMessage.ID.make("msg_agent_run_handler_terminal"), callID: "terminal" },
      agent: AgentV2.ID.make("build"),
      description: "Implement the handler",
      background: false,
      ownerID: "test-process",
    })
    yield* runs.transition({ id: terminal.info.id, ownerID: "test-process", state: { type: "succeeded" } })
    yield* runs.admit({
      sessionID: secondChildSessionID,
      callerSessionID: secondRootSessionID,
      source: { messageID: SessionMessage.ID.make("msg_agent_run_handler_second_active"), callID: "second-active" },
      agent: AgentV2.ID.make("review"),
      description: "Review another session tree",
      background: true,
      ownerID: "test-process",
    })
    fixture.snapshot = Schema.encodeSync(AgentRun.Snapshot)(yield* runs.snapshot(rootSessionID))
    fixture.overview = Schema.encodeSync(AgentRun.Overview)(yield* runs.overview())
  }),
)

const SessionApi = HttpApi.make("server").add(
  makeSessionGroup(SessionLocationMiddleware).middleware(Authorization).middleware(SchemaErrorMiddleware),
)
const routes = Layer.mergeAll(
  HttpApiBuilder.layer(SessionApi).pipe(
    Layer.provide(SessionHandler),
    Layer.provide(sessionLocationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() })),
  ),
  seed,
).pipe(Layer.provide(services), Layer.provide(HttpServer.layerServices))
const app = HttpRouter.toWebHandler(routes, { disableLogger: true })

afterAll(() => app.dispose())

test("serves the canonical recursive agent-run snapshot and rejects an unknown session", async () => {
  const response = await app.handler(new Request(`http://localhost/api/session/${rootSessionID}/agent-run`))
  const missing = await app.handler(new Request(`http://localhost/api/session/${missingSessionID}/agent-run`))

  expect(response.status).toBe(200)
  const body = Schema.decodeUnknownSync(AgentRun.Snapshot)(await response.json())
  if (fixture.snapshot === undefined) throw new Error("Agent-run fixture was not seeded")
  expect(Schema.encodeSync(AgentRun.Snapshot)(body)).toEqual(fixture.snapshot)
  expect(body.nodes.map((node) => node.sessionID)).toEqual([childSessionID, grandchildSessionID])
  expect(body.active.map((run) => run.sessionID)).toEqual([childSessionID])
  expect(body.history.map((run) => run.sessionID)).toEqual([grandchildSessionID])
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({
    _tag: "SessionNotFoundError",
    sessionID: missingSessionID,
    message: `Session not found: ${missingSessionID}`,
  })
})

test("serves the server-wide agent-run overview across session roots", async () => {
  const response = await app.handler(new Request("http://localhost/api/agent-run"))

  expect(response.status).toBe(200)
  const body = Schema.decodeUnknownSync(AgentRun.Overview)(await response.json())
  if (fixture.overview === undefined) throw new Error("Agent-run overview fixture was not seeded")
  expect(Schema.encodeSync(AgentRun.Overview)(body)).toEqual(fixture.overview)
  expect(body.nodes.map((node) => node.sessionID)).toEqual([childSessionID, grandchildSessionID, secondChildSessionID])
  expect(new Set(body.active.map((run) => run.sessionID))).toEqual(new Set([childSessionID, secondChildSessionID]))
  expect(body.history.map((run) => run.sessionID)).toEqual([grandchildSessionID])
})
