import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime, Effect, Layer, Queue, Schema, Stream } from "effect"
import { GlobalBus } from "../../src/bus/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect, testEffectShared } from "../lib/effect"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const buffers = new WeakMap<Queue.Dequeue<Uint8Array>, string>()

function readData(reader: Queue.Dequeue<Uint8Array>): Effect.Effect<unknown, Error> {
  const read = (buffer: string): Effect.Effect<unknown, Error> => {
    const end = buffer.indexOf("\n\n")
    if (end === -1) {
      return Queue.take(reader).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for event")),
        }),
        Effect.flatMap((value) => read(buffer + new TextDecoder().decode(value).replaceAll("\r\n", "\n"))),
      )
    }
    const data = buffer.slice(0, end).match(/^data: (.*)$/m)?.[1]
    const rest = buffer.slice(end + 2)
    buffers.set(reader, rest)
    if (!data) return read(rest)
    return Effect.sync(() => JSON.parse(data) as unknown)
  }
  return read(buffers.get(reader) ?? "")
}

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  readData(reader).pipe(Effect.map(Schema.decodeUnknownSync(EventData)))

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

const openGlobalEventStream = Effect.gen(function* () {
  const response = yield* request(GlobalPaths.event)
  const reader = yield* Queue.unbounded<Uint8Array>()
  yield* response.stream.pipe(
    Stream.runForEach((value) => Queue.offer(reader, value)),
    Effect.forkScoped,
  )
  return { response, reader }
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)
const sharedIt = testEffectShared(Layer.mergeAll(httpApiLayer, LayerNode.compile(EventV2Bridge.node)))

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  sharedIt.instance(
    "encodes DateTime values for legacy instance and global streams",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        const session = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(yield* created.json)
        const instanceStream = yield* openEventStream(directory)
        const globalStream = yield* openGlobalEventStream
        expect(yield* readEvent(instanceStream.reader)).toMatchObject({ type: "server.connected" })
        expect(yield* readData(globalStream.reader)).toMatchObject({ payload: { type: "server.connected" } })

        const events = yield* EventV2Bridge.Service
        const timestamp = DateTime.makeUnsafe(1_723_689_000_123)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: SessionV2.ID.make(session.id),
          messageID: SessionMessage.ID.create(),
          timestamp,
          agent: "build",
        })

        expect(yield* readEvent(instanceStream.reader)).toMatchObject({
          type: "session.next.agent.switched",
          properties: { timestamp: 1_723_689_000_123 },
        })
        expect(yield* readData(globalStream.reader)).toMatchObject({
          directory,
          payload: {
            type: "session.next.agent.switched",
            properties: { timestamp: 1_723_689_000_123 },
          },
        })
        expect(yield* readData(globalStream.reader)).toMatchObject({
          directory,
          payload: {
            type: "sync",
            syncEvent: {
              type: "session.next.agent.switched.1",
              data: { timestamp: 1_723_689_000_123 },
            },
          },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "relays already encoded DateTime values on the global stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const globalStream = yield* openGlobalEventStream
        expect(yield* readData(globalStream.reader)).toMatchObject({ payload: { type: "server.connected" } })

        const data = {
          sessionID: SessionV2.ID.make("ses_remote"),
          messageID: SessionMessage.ID.create(),
          timestamp: 1_723_689_000_123,
          agent: "build",
        }
        GlobalBus.emit("event", {
          directory,
          workspace: "wrk_remote",
          payload: { type: SessionEvent.AgentSwitched.type, properties: data },
        })
        expect(yield* readData(globalStream.reader)).toMatchObject({
          directory,
          workspace: "wrk_remote",
          payload: { type: "session.next.agent.switched", properties: { timestamp: 1_723_689_000_123 } },
        })

        GlobalBus.emit("event", {
          directory,
          workspace: "wrk_remote",
          payload: {
            type: "sync",
            syncEvent: {
              id: "evt_remote",
              type: "session.next.agent.switched.1",
              seq: 1,
              aggregateID: data.sessionID,
              data,
            },
          },
        })
        expect(yield* readData(globalStream.reader)).toMatchObject({
          directory,
          workspace: "wrk_remote",
          payload: {
            type: "sync",
            syncEvent: {
              type: "session.next.agent.switched.1",
              data: { timestamp: 1_723_689_000_123 },
            },
          },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
