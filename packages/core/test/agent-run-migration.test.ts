import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import agentRunMigration from "@opencode-ai/core/database/migration/20260810034629_agent-run"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("AgentRun migration", () => {
  test("backfills only trustworthy legacy task runs and journals the migration", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session (id text PRIMARY KEY, parent_id text, title text, agent text, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`
          INSERT INTO session (id, title, agent, time_created, time_updated)
          VALUES
            ('ses_parent', 'Parent', 'build', 1, 300),
            ('ses_child', 'Inspect code (@explore subagent)', 'explore', 100, 190),
            ('ses_background', 'Research options (@explore subagent)', 'explore', 200, 290),
            ('ses_failed', 'Check failure (@general subagent)', 'general', 300, 390),
            ('ses_cancelled', 'Stop cleanly (@general subagent)', 'general', 400, 490),
            ('ses_interrupted', 'Handle abort (@general subagent)', 'general', 500, 590),
            ('ses_pending', 'Pending legacy (@explore subagent)', 'explore', 600, 690),
            ('ses_running', 'Running legacy (@explore subagent)', 'explore', 700, 790),
            ('ses_task_error', 'Explicit task error (@general subagent)', 'general', 800, 890),
            ('ses_resumed', 'Reusable task (@general subagent)', 'general', 900, 1090),
            ('ses_malformed', 'Malformed task (@general subagent)', 'general', 1100, 1190),
            ('ses_lookalike', 'Missing child (@general subagent)', 'general', 1200, 1290),
            ('ses_bad_message', 'Malformed message (@general subagent)', 'general', 1300, 1390),
            ('ses_legacy_id', 'Legacy message ID (@general subagent)', 'general', 1400, 1490)
        `)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_foreground', 'ses_parent', 90, 190, ${JSON.stringify({ role: "assistant" })}), ('msg_background', 'ses_parent', 195, 290, ${JSON.stringify({ role: "assistant" })}), ('msg_failed', 'ses_parent', 295, 390, ${JSON.stringify({ role: "assistant" })}), ('msg_cancelled', 'ses_parent', 395, 490, ${JSON.stringify({ role: "assistant" })}), ('msg_interrupted', 'ses_parent', 495, 590, ${JSON.stringify({ role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } })}), ('msg_pending', 'ses_parent', 595, 690, ${JSON.stringify({ role: "assistant" })}), ('msg_running', 'ses_parent', 695, 790, ${JSON.stringify({ role: "assistant" })}), ('msg_task_error', 'ses_parent', 795, 890, ${JSON.stringify({ role: "assistant" })}), ('msg_resume_first', 'ses_parent', 895, 990, ${JSON.stringify({ role: "assistant" })}), ('msg_resume_second', 'ses_parent', 995, 1090, ${JSON.stringify({ role: "assistant" })}), ('msg_malformed', 'ses_parent', 1095, 1190, ${JSON.stringify({ role: "assistant" })}), ('msg_missing', 'ses_parent', 1195, 1290, ${JSON.stringify({ role: "assistant" })}), ('msg_bad_message', 'ses_parent', 1295, 1390, '{')`,
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msglegacy', 'ses_parent', 1395, 1490, ${JSON.stringify({ role: "assistant" })})`,
        )
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_foreground',
            'msg_foreground',
            'ses_parent',
            100,
            190,
            ${JSON.stringify({
              type: "tool",
              callID: "call_foreground",
              tool: "task",
              state: {
                status: "completed",
                input: {
                  prompt: "Inspect the implementation",
                  description: "Inspect code",
                  subagent_type: "explore",
                },
                title: "Inspect code",
                metadata: {
                  sessionId: "ses_child",
                  model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "high" },
                },
                output: '<task id="ses_child" state="completed">\n<task_result>Done</task_result>\n</task>',
                time: { start: 110, end: 190 },
              },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES
            (
              'prt_resume_first',
              'msg_resume_first',
              'ses_parent',
              900,
              990,
              ${JSON.stringify({
                type: "tool",
                callID: "call_resume_first",
                tool: "task",
                state: {
                  status: "completed",
                  input: {
                    prompt: "Start reusable work",
                    description: "Start reusable",
                    subagent_type: "general",
                  },
                  metadata: { sessionId: "ses_resumed" },
                  output: '<task id="ses_resumed" state="completed"></task>',
                  time: { start: 910, end: 990 },
                },
              })}
            ),
            (
              'prt_resume_second',
              'msg_resume_second',
              'ses_parent',
              1000,
              1090,
              ${JSON.stringify({
                type: "tool",
                callID: "call_resume_second",
                tool: "task",
                state: {
                  status: "completed",
                  input: {
                    prompt: "Continue reusable work",
                    description: "Continue reusable",
                    subagent_type: "general",
                    task_id: "ses_resumed",
                  },
                  metadata: { sessionID: "ses_resumed" },
                  output: '<task id="ses_resumed" state="completed"></task>',
                  time: { start: 1010, end: 1090 },
                },
              })}
            ),
            (
              'prt_bad_message',
              'msg_bad_message',
              'ses_parent',
              1300,
              1390,
              ${JSON.stringify({
                type: "tool",
                callID: "call_bad_message",
                tool: "task",
                state: {
                  status: "completed",
                  input: {
                    prompt: "Do not trust a malformed message",
                    description: "Malformed message",
                    subagent_type: "general",
                  },
                  metadata: { sessionId: "ses_bad_message" },
                  output: '<task id="ses_bad_message" state="completed"></task>',
                  time: { start: 1310, end: 1390 },
                },
              })}
            )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_legacy_id',
            'msglegacy',
            'ses_parent',
            1400,
            1490,
            ${JSON.stringify({
              type: "tool",
              callID: "call_legacy_id",
              tool: "task",
              state: {
                status: "completed",
                input: {
                  prompt: "Do not backfill an incompatible source message ID",
                  description: "Legacy message ID",
                  subagent_type: "general",
                },
                metadata: { sessionId: "ses_legacy_id" },
                output: '<task id="ses_legacy_id" state="completed"></task>',
                time: { start: 1410, end: 1490 },
              },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_task_error',
            'msg_task_error',
            'ses_parent',
            800,
            890,
            ${JSON.stringify({
              type: "tool",
              callID: "call_task_error",
              tool: "task",
              state: {
                status: "completed",
                input: {
                  prompt: "Report an explicit task error",
                  description: "Explicit task error",
                  subagent_type: "general",
                },
                metadata: { sessionId: "ses_task_error" },
                output:
                  '<task id="ses_task_error" state="error">\n<task_error>Child failed explicitly</task_error>\n</task>',
                time: { start: 810, end: 890 },
              },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES
            (
              'prt_pending',
              'msg_pending',
              'ses_parent',
              600,
              690,
              ${JSON.stringify({
                type: "tool",
                callID: "call_pending",
                tool: "task",
                state: {
                  status: "pending",
                  sessionId: "ses_pending",
                  input: {
                    prompt: "Remain pending",
                    description: "Pending legacy",
                    subagent_type: "explore",
                  },
                  raw: "{}",
                },
              })}
            ),
            (
              'prt_running',
              'msg_running',
              'ses_parent',
              700,
              790,
              ${JSON.stringify({
                type: "tool",
                callID: "call_running",
                tool: "task",
                state: {
                  status: "running",
                  input: {
                    prompt: "Remain running",
                    description: "Running legacy",
                    subagent_type: "explore",
                  },
                  metadata: { sessionID: "ses_running" },
                  time: { start: 710 },
                },
              })}
            )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_interrupted',
            'msg_interrupted',
            'ses_parent',
            500,
            590,
            ${JSON.stringify({
              type: "tool",
              callID: "call_interrupted",
              tool: "task",
              state: {
                status: "error",
                input: {
                  prompt: "Wait until aborted",
                  description: "Handle abort",
                  subagent_type: "general",
                },
                metadata: { sessionId: "ses_interrupted", interrupted: true },
                error: "Tool execution aborted",
                time: { start: 510, end: 590 },
              },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_cancelled',
            'msg_cancelled',
            'ses_parent',
            400,
            490,
            ${JSON.stringify({
              type: "tool",
              callID: "call_cancelled",
              tool: "task",
              state: {
                status: "error",
                input: {
                  prompt: "Stop this task",
                  description: "Stop cleanly",
                  subagent_type: "general",
                },
                metadata: { sessionID: "ses_cancelled" },
                error: "Task cancelled",
                time: { start: 410, end: 490 },
              },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_failed',
            'msg_failed',
            'ses_parent',
            300,
            390,
            ${JSON.stringify({
              type: "tool",
              callID: "call_failed",
              tool: "task",
              state: {
                status: "error",
                input: {
                  prompt: "Exercise the failure",
                  description: "Check failure",
                  subagent_type: "general",
                },
                metadata: { sessionId: "ses_failed" },
                error: "Provider exploded",
                time: { start: 310, end: 390 },
              },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_background',
            'msg_background',
            'ses_parent',
            200,
            290,
            ${JSON.stringify({
              type: "tool",
              callID: "call_background",
              tool: "task",
              state: {
                status: "completed",
                input: {
                  prompt: "Research the options",
                  description: "Research options",
                  subagent_type: "explore",
                  background: true,
                },
                title: "Research options",
                metadata: { sessionID: "ses_background", background: true },
                output:
                  '<task id="ses_background" state="running">\n<task_result>Background task started</task_result>\n</task>',
                time: { start: 210, end: 290 },
              },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES
            ('prt_malformed', 'msg_malformed', 'ses_parent', 1100, 1190, '{'),
            (
              'prt_missing',
              'msg_missing',
              'ses_parent',
              1200,
              1290,
              ${JSON.stringify({
                type: "tool",
                callID: "call_missing",
                tool: "task",
                state: {
                  status: "completed",
                  input: {
                    prompt: "Do not infer the child",
                    description: "Missing child",
                    subagent_type: "general",
                  },
                  metadata: { sessionId: "ses_missing" },
                  output: '<task id="ses_missing" state="completed"></task>',
                  time: { start: 1210, end: 1290 },
                },
              })}
            )
        `)

        yield* DatabaseMigration.applyOnly(db, [agentRunMigration])
        yield* DatabaseMigration.applyOnly(db, [agentRunMigration])

        expect(yield* db.all(sql`SELECT * FROM agent_run ORDER BY time_created, id`)).toEqual([
          {
            id: "arun_prt_foreground",
            session_id: "ses_child",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_foreground",
            source_call_id: "call_foreground",
            agent: "explore",
            description: "Inspect code",
            model_provider_id: "anthropic",
            model_id: "claude-sonnet",
            model_variant: "high",
            background: 0,
            state_type: "succeeded",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: null,
            owner_id: null,
            activity_at: 190,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 100,
            time_started: 110,
            time_updated: 190,
            time_finished: 190,
            version: 0,
          },
          {
            id: "arun_prt_background",
            session_id: "ses_background",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_background",
            source_call_id: "call_background",
            agent: "explore",
            description: "Research options",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 1,
            state_type: "unknown",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: "legacy_ambiguous",
            owner_id: null,
            activity_at: 290,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 200,
            time_started: 210,
            time_updated: 290,
            time_finished: 290,
            version: 0,
          },
          {
            id: "arun_prt_failed",
            session_id: "ses_failed",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_failed",
            source_call_id: "call_failed",
            agent: "general",
            description: "Check failure",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "failed",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: "Provider exploded",
            state_reason: null,
            owner_id: null,
            activity_at: 390,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 300,
            time_started: 310,
            time_updated: 390,
            time_finished: 390,
            version: 0,
          },
          {
            id: "arun_prt_cancelled",
            session_id: "ses_cancelled",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_cancelled",
            source_call_id: "call_cancelled",
            agent: "general",
            description: "Stop cleanly",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "cancelled",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: null,
            owner_id: null,
            activity_at: 490,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 400,
            time_started: 410,
            time_updated: 490,
            time_finished: 490,
            version: 0,
          },
          {
            id: "arun_prt_interrupted",
            session_id: "ses_interrupted",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_interrupted",
            source_call_id: "call_interrupted",
            agent: "general",
            description: "Handle abort",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "interrupted",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: "Tool execution aborted",
            owner_id: null,
            activity_at: 590,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 500,
            time_started: 510,
            time_updated: 590,
            time_finished: 590,
            version: 0,
          },
          {
            id: "arun_prt_pending",
            session_id: "ses_pending",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_pending",
            source_call_id: "call_pending",
            agent: "explore",
            description: "Pending legacy",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "unknown",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: "legacy_ambiguous",
            owner_id: null,
            activity_at: 690,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 600,
            time_started: null,
            time_updated: 690,
            time_finished: 690,
            version: 0,
          },
          {
            id: "arun_prt_running",
            session_id: "ses_running",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_running",
            source_call_id: "call_running",
            agent: "explore",
            description: "Running legacy",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "unknown",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: "legacy_ambiguous",
            owner_id: null,
            activity_at: 790,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 700,
            time_started: 710,
            time_updated: 790,
            time_finished: 790,
            version: 0,
          },
          {
            id: "arun_prt_task_error",
            session_id: "ses_task_error",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_task_error",
            source_call_id: "call_task_error",
            agent: "general",
            description: "Explicit task error",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "failed",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: "Child failed explicitly",
            state_reason: null,
            owner_id: null,
            activity_at: 890,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 800,
            time_started: 810,
            time_updated: 890,
            time_finished: 890,
            version: 0,
          },
          {
            id: "arun_prt_resume_first",
            session_id: "ses_resumed",
            caller_session_id: "ses_parent",
            previous_run_id: null,
            source_message_id: "msg_resume_first",
            source_call_id: "call_resume_first",
            agent: "general",
            description: "Start reusable",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "succeeded",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: null,
            owner_id: null,
            activity_at: 990,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 900,
            time_started: 910,
            time_updated: 990,
            time_finished: 990,
            version: 0,
          },
          {
            id: "arun_prt_resume_second",
            session_id: "ses_resumed",
            caller_session_id: "ses_parent",
            previous_run_id: "arun_prt_resume_first",
            source_message_id: "msg_resume_second",
            source_call_id: "call_resume_second",
            agent: "general",
            description: "Continue reusable",
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            background: 0,
            state_type: "succeeded",
            state_attempt: null,
            state_message: null,
            state_next: null,
            state_error: null,
            state_reason: null,
            owner_id: null,
            activity_at: 1090,
            activity_summary: null,
            activity_revision: 0,
            summary_revision: null,
            time_created: 1000,
            time_started: 1010,
            time_updated: 1090,
            time_finished: 1090,
            version: 0,
          },
        ])
        expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM part`)).toEqual({ count: 14 })
        expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM agent_run`)).toEqual({ count: 10 })
        expect(
          yield* db.all(
            sql`SELECT state_type, COUNT(*) AS count FROM agent_run GROUP BY state_type ORDER BY state_type`,
          ),
        ).toEqual([
          { state_type: "cancelled", count: 1 },
          { state_type: "failed", count: 2 },
          { state_type: "interrupted", count: 1 },
          { state_type: "succeeded", count: 3 },
          { state_type: "unknown", count: 3 },
        ])
        expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM migration WHERE id = ${agentRunMigration.id}`)).toEqual({
          count: 1,
        })
        expect(
          yield* db.all(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'agent_run'
            ORDER BY name
          `),
        ).toEqual([
          { name: "agent_run_active_idx" },
          { name: "agent_run_admission_idx" },
          { name: "agent_run_history_idx" },
          { name: "agent_run_owner_idx" },
          { name: "agent_run_session_time_idx" },
          { name: "sqlite_autoindex_agent_run_1" },
        ])
      }),
    )
  })
})
