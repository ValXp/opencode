import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import type { AgentSessionUsage } from "./format"
import type { AgentsProjection } from "./model"
import { AgentRunRow } from "./run-row"

export type { AgentSessionUsage } from "./format"

type AgentSessionID = AgentsProjection["rows"][number]["node"]["sessionID"]

export interface AgentsPanelProps {
  projection: AgentsProjection
  historyVisible?: boolean
  now?: () => number
  expanded?: (sessionID: AgentSessionID) => boolean
  onExpandedChange?: (sessionID: AgentSessionID, expanded: boolean) => void
  usage?: (sessionID: AgentSessionID) => AgentSessionUsage | undefined
  onHistoryVisibleChange: (visible: boolean) => void
  onOpenSession: (sessionID: AgentSessionID) => void
  class?: string
}

export function AgentsPanel(props: AgentsPanelProps) {
  const language = useLanguage()

  return (
    <section
      data-component="agents-panel"
      aria-label={language.t("settings.agents.title")}
      class={`flex min-h-0 flex-col bg-background-base ${props.class ?? ""}`}
    >
      <header class="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border-weaker-base px-3">
        <h2 class="text-13-medium text-text-strong">{language.t("settings.agents.title")}</h2>
        <span data-slot="agents-summary" dir="auto" class="text-11-regular text-text-weak">
          {language.t("session.agents.summary", {
            active: props.projection.activeCount,
            total: props.projection.totalCount,
          })}
        </span>
      </header>

      <Show
        when={props.projection.rows.length > 0}
        fallback={
          <div
            role="status"
            class="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center text-12-regular text-text-weak"
          >
            {language.t("session.agents.empty")}
          </div>
        }
      >
        <ul class="min-h-0 flex-1 overflow-y-auto py-1">
          <For each={props.projection.rows}>
            {(row) => (
              <AgentRunRow
                row={row}
                now={props.now}
                expanded={props.expanded?.(row.node.sessionID)}
                onExpandedChange={(expanded) => props.onExpandedChange?.(row.node.sessionID, expanded)}
                usage={props.usage?.(row.node.sessionID)}
                onOpenSession={props.onOpenSession}
              />
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.projection.hiddenHistoryCount > 0 || props.historyVisible}>
        <div class="shrink-0 border-t border-border-weaker-base p-2">
          <Button
            size="small"
            variant="ghost"
            class="w-full"
            onClick={() => props.onHistoryVisibleChange(!props.historyVisible)}
          >
            {props.historyVisible
              ? language.t("session.agents.hideHistory")
              : language.t("session.agents.showHistory", { count: props.projection.hiddenHistoryCount })}
          </Button>
        </div>
      </Show>
    </section>
  )
}
