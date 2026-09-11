import { afterAll, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { CodexUsage } from "@opencode-ai/core/codex-usage"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { IntegrationGroup } from "@opencode-ai/protocol/groups/integration"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "../src/auth"
import { IntegrationHandler } from "../src/handlers/integration"
import { authorizationLayer } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { layer, LocationMiddleware } from "../src/location"

const services = AppNodeBuilder.build(
  LayerNode.group([Integration.node, Credential.node, CodexUsage.node, LocationServiceMap.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const api = HttpApi.make("server").add(
  IntegrationGroup.middleware(LocationMiddleware).middleware(Authorization).middleware(SchemaErrorMiddleware),
)
const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(IntegrationHandler),
  Layer.provide(layer),
  Layer.provide(authorizationLayer),
  Layer.provide(schemaErrorLayer),
  Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.some("test-password") })),
  Layer.provide(services),
  Layer.provide(HttpServer.layerServices),
)
const app = HttpRouter.toWebHandler(routes, { disableLogger: true })
afterAll(() => app.dispose())

test("quota endpoint requires server authentication and returns a non-cacheable sanitized response", async () => {
  const denied = await app.handler(new Request("http://localhost/api/integration/openai/usage"))
  expect(denied.status).toBe(401)
  const result = await app.handler(
    new Request("http://localhost/api/integration/openai/usage?location[directory]=/tmp/opencode", {
      headers: { Authorization: `Basic ${btoa("opencode:test-password")}` },
    }),
  )
  expect(result.status).toBe(200)
  expect(result.headers.get("cache-control")).toBe("no-store")
  const body = await result.json()
  expect(body.location.directory).toBe("/tmp/opencode")
  expect(body.data).toEqual({ status: "unsupported", windows: [] })
})
