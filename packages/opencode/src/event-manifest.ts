export * as EventManifest from "./event-manifest"

import { Durable, Latest } from "@opencode-ai/schema/event-manifest"
import { Option, Schema } from "effect"

export { Definitions } from "@opencode-ai/schema/event-manifest"
export { Durable, Latest }

export function encodeLegacyWireEvent(input: unknown): unknown {
  if (!isRecord(input)) return input
  if (typeof input.type === "string") return encodePayload(input)
  if (!("payload" in input)) return input
  return { ...input, payload: encodePayload(input.payload) }
}

function encodePayload(input: unknown): unknown {
  if (!isRecord(input) || typeof input.type !== "string") return input
  const definition = Latest.get(input.type)
  if (definition) {
    return { ...input, properties: encodeData(definition.data, input.properties) }
  }
  if (input.type !== "sync" || !isRecord(input.syncEvent) || typeof input.syncEvent.type !== "string") return input
  const durable = Durable.get(input.syncEvent.type)
  if (!durable) return input
  return {
    ...input,
    syncEvent: { ...input.syncEvent, data: encodeData(durable.data, input.syncEvent.data) },
  }
}

function encodeData(schema: Schema.Codec<unknown, unknown>, input: unknown) {
  const encoded = Schema.encodeUnknownOption(schema)(input)
  if (Option.isSome(encoded)) return encoded.value
  return Schema.decodeUnknownSync(Schema.toEncoded(schema))(input)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
