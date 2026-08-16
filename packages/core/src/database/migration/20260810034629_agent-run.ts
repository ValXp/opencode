import { SessionMessage } from "@opencode-ai/schema/session-message"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { DatabaseMigration } from "../migration"

type LegacyPartRow = {
  part_id: string
  message_id: string
  caller_session_id: string
  time_created: number
  time_updated: number
  data: string
  message_data: string
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeMessageID = Schema.decodeUnknownOption(SessionMessage.ID)

export default {
  id: "20260810034629_agent-run",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_run\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`caller_session_id\` text NOT NULL,
          \`previous_run_id\` text,
          \`source_message_id\` text NOT NULL,
          \`source_call_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`description\` text NOT NULL,
          \`model_provider_id\` text,
          \`model_id\` text,
          \`model_variant\` text,
          \`background\` integer NOT NULL,
          \`state_type\` text NOT NULL,
          \`state_attempt\` integer,
          \`state_message\` text,
          \`state_next\` integer,
          \`state_error\` text,
          \`state_reason\` text,
          \`owner_id\` text,
          \`activity_at\` integer NOT NULL,
          \`activity_summary\` text,
          \`activity_revision\` integer DEFAULT 0 NOT NULL,
          \`summary_revision\` integer,
          \`time_created\` integer NOT NULL,
          \`time_started\` integer,
          \`time_updated\` integer NOT NULL,
          \`time_finished\` integer,
          \`version\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_agent_run_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_agent_run_caller_session_id_session_id_fk\` FOREIGN KEY (\`caller_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`agent_run_admission_idx\` ON \`agent_run\` (\`caller_session_id\`,\`source_message_id\`,\`source_call_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`agent_run_session_time_idx\` ON \`agent_run\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`agent_run_active_idx\` ON \`agent_run\` (\`state_type\`,\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`agent_run_owner_idx\` ON \`agent_run\` (\`owner_id\`,\`state_type\`);`)
      yield* tx.run(`CREATE INDEX \`agent_run_history_idx\` ON \`agent_run\` (\`time_finished\`,\`id\`);`)

      const sessions = new Set((yield* tx.all<{ id: string }>(sql`SELECT id FROM session`)).map((row) => row.id))
      const rows = yield* tx.all<LegacyPartRow>(sql`
        SELECT
          part.id AS part_id,
          part.message_id,
          part.session_id AS caller_session_id,
          part.time_created,
          part.time_updated,
          part.data,
          message.data AS message_data
        FROM part
        INNER JOIN message
          ON message.id = part.message_id
          AND message.session_id = part.session_id
        ORDER BY part.time_created, part.id
      `)
      const previousBySession = new Map<string, string>()
      const runs = rows
        .flatMap((row) => {
          const run = legacyRun(row, sessions)
          return run ? [run] : []
        })
        .map((run) => {
          const previousRunID = previousBySession.get(run.sessionID)
          previousBySession.set(run.sessionID, run.id)
          return { ...run, previousRunID }
        })
      yield* Effect.forEach(
        runs,
        (run) =>
          tx.run(sql`
            INSERT INTO agent_run (
              id,
              session_id,
              caller_session_id,
              previous_run_id,
              source_message_id,
              source_call_id,
              agent,
              description,
              model_provider_id,
              model_id,
              model_variant,
              background,
              state_type,
              state_error,
              state_reason,
              owner_id,
              activity_at,
              time_created,
              time_started,
              time_updated,
              time_finished
            ) VALUES (
              ${run.id},
              ${run.sessionID},
              ${run.callerSessionID},
              ${run.previousRunID ?? null},
              ${run.messageID},
              ${run.callID},
              ${run.agent},
              ${run.description},
              ${run.model?.providerID ?? null},
              ${run.model?.modelID ?? null},
              ${run.model?.variant ?? null},
              ${run.background},
              ${run.state.type},
              ${run.state.type === "failed" ? run.state.error : null},
              ${run.state.type === "unknown" || run.state.type === "interrupted" ? run.state.reason : null},
              NULL,
              ${run.updated},
              ${run.created},
              ${run.started ?? null},
              ${run.updated},
              ${run.finished}
            )
          `),
        { discard: true },
      )
    })
  },
} satisfies DatabaseMigration.Migration

function legacyRun(row: LegacyPartRow, sessions: ReadonlySet<string>) {
  if (!sessions.has(row.caller_session_id)) return
  const messageID = Option.getOrUndefined(decodeMessageID(row.message_id))
  if (!messageID) return
  const data = Option.getOrUndefined(decodeJson(row.data))
  if (!isRecord(data)) return
  if (data.type !== "tool" || data.tool !== "task") return
  if (typeof data.callID !== "string" || data.callID.length === 0) return
  if (!isRecord(data.state)) return
  const status = data.state.status
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "error") return
  if (!isRecord(data.state.input)) return
  if (typeof data.state.input.subagent_type !== "string" || data.state.input.subagent_type.length === 0) return
  if (typeof data.state.input.description !== "string") return
  const metadata = isRecord(data.state.metadata) ? data.state.metadata : undefined
  const partMetadata = isRecord(data.metadata) ? data.metadata : undefined
  const sessionIDs = [
    metadata?.sessionId,
    metadata?.sessionID,
    data.state.sessionId,
    data.state.sessionID,
    partMetadata?.sessionId,
    partMetadata?.sessionID,
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
  const uniqueSessionIDs = [...new Set(sessionIDs)]
  if (uniqueSessionIDs.length !== 1 || !sessions.has(uniqueSessionIDs[0])) return

  const model = isRecord(metadata?.model)
    ? metadata.model
    : isRecord(partMetadata?.model)
      ? partMetadata.model
      : undefined
  const time = isRecord(data.state.time) ? data.state.time : undefined
  const message = Option.getOrUndefined(decodeJson(row.message_data))
  if (!isRecord(message) || message.role !== "assistant") return
  const output = typeof data.state.output === "string" ? data.state.output : undefined
  const outputState = taskOutputState(output)
  const backgroundRunning = outputState === "running"
  const error = typeof data.state.error === "string" ? data.state.error : undefined
  const state =
    status === "error"
      ? error === undefined
        ? undefined
        : metadata?.interrupted === true || assistantAborted(message) || interruption(error)
          ? ({ type: "interrupted", reason: error } as const)
          : cancellation(error)
            ? ({ type: "cancelled" } as const)
            : ({ type: "failed", error } as const)
      : status === "pending" || status === "running" || backgroundRunning
        ? ({ type: "unknown", reason: "legacy_ambiguous" } as const)
        : outputState === "error"
          ? ({ type: "failed", error: taskOutputError(output) ?? "Legacy task reported an error" } as const)
          : ({ type: "succeeded" } as const)
  if (!state) return
  return {
    id: `arun_${row.part_id}`,
    sessionID: uniqueSessionIDs[0],
    callerSessionID: row.caller_session_id,
    messageID,
    callID: data.callID,
    agent: data.state.input.subagent_type,
    description: data.state.input.description,
    background:
      metadata?.background === true ||
      partMetadata?.background === true ||
      data.state.input.background === true ||
      backgroundRunning,
    state,
    model:
      model && typeof model.providerID === "string" && typeof model.modelID === "string"
        ? {
            providerID: model.providerID,
            modelID: model.modelID,
            variant: typeof model.variant === "string" ? model.variant : undefined,
          }
        : undefined,
    created: row.time_created,
    started: timestamp(time?.start),
    updated: row.time_updated,
    finished: timestamp(time?.end) ?? row.time_updated,
  }
}

function timestamp(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : undefined
}

function cancellation(input: string) {
  return /\bcancel(?:led|ed|lation)?\b/i.test(input)
}

function interruption(input: string) {
  return /\b(?:abort(?:ed)?|interrupt(?:ed|ion)?)\b/i.test(input)
}

function taskOutputState(input: string | undefined) {
  const match = input?.match(/<task\b[^>]*\bstate=(['"])(running|completed|error)\1[^>]*>/i)
  return match?.[2]?.toLowerCase()
}

function taskOutputError(input: string | undefined) {
  const match = input?.match(/<task_error>\s*([\s\S]*?)\s*<\/task_error>/i)
  const error = match?.[1]?.trim()
  return error && error.length > 0 ? error : undefined
}

function assistantAborted(input: unknown) {
  return isRecord(input) && isRecord(input.error) && input.error.name === "MessageAbortedError"
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
