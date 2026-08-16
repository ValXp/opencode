import { AgentRun } from "@opencode-ai/schema/agent-run"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"

export const AgentRunTable = sqliteTable(
  "agent_run",
  {
    id: text().$type<AgentRun.ID>().primaryKey(),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    caller_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    previous_run_id: text().$type<AgentRun.ID>(),
    source_message_id: text().$type<SessionMessage.ID>().notNull(),
    source_call_id: text().notNull(),
    agent: text().$type<Agent.ID>().notNull(),
    description: text().notNull(),
    model_provider_id: text().$type<Provider.ID>(),
    model_id: text().$type<Model.ID>(),
    model_variant: text().$type<Model.VariantID>(),
    background: integer({ mode: "boolean" }).notNull(),
    state_type: text().$type<AgentRun.State["type"]>().notNull(),
    state_attempt: integer(),
    state_message: text(),
    state_next: integer(),
    state_error: text(),
    state_reason: text(),
    owner_id: text(),
    activity_at: integer().notNull(),
    activity_summary: text(),
    activity_revision: integer().notNull().default(0),
    summary_revision: integer(),
    time_created: integer().notNull(),
    time_started: integer(),
    time_updated: integer().notNull(),
    time_finished: integer(),
    version: integer().notNull().default(0),
  },
  (table) => [
    uniqueIndex("agent_run_admission_idx").on(table.caller_session_id, table.source_message_id, table.source_call_id),
    index("agent_run_session_time_idx").on(table.session_id, table.time_created, table.id),
    index("agent_run_active_idx").on(table.state_type, table.session_id, table.time_created, table.id),
    index("agent_run_owner_idx").on(table.owner_id, table.state_type),
    index("agent_run_history_idx").on(table.time_finished, table.id),
  ],
)
