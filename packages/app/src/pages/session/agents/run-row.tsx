import { For, Match, Show, Switch, createEffect, createUniqueId, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import { formatElapsed, formatTimestamp, timestampISOString, type AgentSessionUsage } from "./format"
import type { AgentRow } from "./model"

export interface AgentRunRowProps {
  row: AgentRow
  now?: () => number
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  usage?: AgentSessionUsage
  onOpenSession: (sessionID: AgentRow["node"]["sessionID"]) => void
}

export function AgentRunRow(props: AgentRunRowProps) {
  const language = useLanguage()
  const [store, setStore] = createStore({ now: Date.now(), expanded: false })
  const active = () => props.row.state?.type === "running" || props.row.state?.type === "retrying"
  const now = () => props.now?.() ?? store.now
  const ageSeconds = () => Math.floor((props.row.freshness?.ageMs ?? 0) / 1_000)
  const inactive = () => props.row.freshness?.inactive ?? false
  const statusLabel = () => {
    switch (props.row.state?.type) {
      case "running":
        return language.t("session.agents.status.running")
      case "retrying":
        return language.t("session.agents.status.retrying")
      case "succeeded":
        return language.t("session.agents.status.succeeded")
      case "failed":
        return language.t("session.agents.status.failed")
      case "cancelled":
        return language.t("session.agents.status.cancelled")
      case "interrupted":
        return language.t("session.agents.status.interrupted")
      case "unknown":
        return language.t("session.agents.status.unknown")
    }
    if (props.row.contextOnly) return language.t("session.agents.context")
    return language.t("common.unknown")
  }
  const detailsID = createUniqueId()
  const expanded = () => props.expanded ?? store.expanded
  const toggle = () => {
    const next = !expanded()
    if (props.expanded === undefined) setStore("expanded", next)
    props.onExpandedChange?.(next)
  }
  const times = () => [
    {
      label: language.t("session.agents.details.created"),
      value: props.row.current?.time.created ?? props.row.node.createdAt,
    },
    { label: language.t("session.agents.details.started"), value: props.row.current?.time.started },
    { label: language.t("session.agents.details.updated"), value: props.row.current?.time.updated },
    { label: language.t("session.agents.details.finished"), value: props.row.current?.time.finished },
  ]
  const model = () => {
    const value = props.row.current?.model
    if (!value) return language.t("common.unknown")
    return `${value.providerID}/${value.id}${value.variant ? ` (${value.variant})` : ""}`
  }
  const usageTokens = () => {
    const tokens = props.usage?.tokens
    if (!tokens) return language.t("common.unknown")
    return (tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write).toLocaleString(
      language.intl(),
    )
  }
  const usageCost = () => {
    const cost = props.usage?.cost
    if (cost === undefined) return language.t("common.unknown")
    return new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }).format(cost)
  }
  const stateDetail = () => {
    const state = props.row.state
    if (!state) return undefined
    switch (state.type) {
      case "retrying":
        return language.t("session.agents.details.retry", {
          attempt: state.attempt,
          message: state.message,
          next: formatTimestamp(state.next, language.intl()),
        })
      case "failed":
        return language.t("session.agents.details.error", { error: state.error })
      case "interrupted":
        return language.t("session.agents.details.reason", {
          reason: state.reason ?? language.t("common.unknown"),
        })
      case "unknown":
        return language.t("session.agents.details.reason", { reason: state.reason })
    }
    return undefined
  }

  createEffect(() => {
    if (props.now || !active()) return
    setStore("now", Date.now())
    const timer = window.setInterval(() => setStore("now", Date.now()), 1_000)
    onCleanup(() => window.clearInterval(timer))
  })

  return (
    <li
      data-component="agent-run-row"
      data-depth={props.row.depth}
      data-state={props.row.state?.type}
      data-context-only={props.row.contextOnly ? "true" : undefined}
      class="px-1"
      classList={{ "opacity-60": props.row.contextOnly }}
      style={{ "padding-inline-start": `${4 + props.row.depth * 16}px` }}
    >
      <div class="rounded-md text-13-regular text-text-base hover:bg-surface-raised-base-hover">
        <button
          type="button"
          aria-expanded={expanded()}
          aria-controls={detailsID}
          class="w-full px-2 py-2 text-start"
          onClick={toggle}
        >
          <div class="flex min-w-0 items-center gap-2">
            <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
              <Switch fallback={<Icon name="dash" size="small" />}>
                <Match when={props.row.state?.type === "running"}>
                  <Spinner class="size-3 text-icon-success-base" />
                </Match>
                <Match when={props.row.state?.type === "succeeded"}>
                  <Icon name="circle-check" size="small" class="text-icon-success-base" />
                </Match>
                <Match when={props.row.state?.type === "retrying"}>
                  <Icon name="reset" size="small" class="text-icon-warning-base" />
                </Match>
                <Match when={props.row.state?.type === "failed"}>
                  <Icon name="circle-x" size="small" class="text-icon-critical-base" />
                </Match>
                <Match when={props.row.state?.type === "cancelled"}>
                  <Icon name="circle-ban-sign" size="small" class="text-icon-base" />
                </Match>
                <Match when={props.row.state?.type === "interrupted"}>
                  <Icon name="stop" size="small" class="text-icon-warning-base" />
                </Match>
                <Match when={props.row.state?.type === "unknown"}>
                  <Icon name="help" size="small" class="text-icon-warning-base" />
                </Match>
              </Switch>
            </span>
            <span class="min-w-0 flex-1 truncate text-text-strong">{props.row.node.title}</span>
            <span class="shrink-0 text-11-regular text-text-weak">{statusLabel()}</span>
            <Icon
              name="chevron-down"
              size="small"
              class="shrink-0 text-icon-base transition-transform"
              style={{ transform: `rotate(${expanded() ? 180 : 0}deg)` }}
            />
          </div>
          <Show when={props.row.current?.activity.summary || inactive()}>
            <div
              data-slot="agent-activity"
              class="mt-1 truncate ps-6 text-11-regular"
              classList={{ "text-text-weak": !inactive(), "text-icon-warning-base": inactive() }}
            >
              {inactive()
                ? language.t("session.agents.activity.inactive", {
                    seconds: ageSeconds(),
                    summary: props.row.current?.activity.summary ?? statusLabel(),
                  })
                : props.row.current?.activity.summary}
            </div>
          </Show>
        </button>
        <span data-slot="agent-status-live" aria-live="polite" aria-atomic="true" class="sr-only">
          {statusLabel()}
        </span>
        <Show when={props.row.current?.activity.summary}>
          {(summary) => (
            <span data-slot="agent-activity-live" aria-live="polite" aria-atomic="true" class="sr-only">
              {summary()}
            </span>
          )}
        </Show>

        <Show when={expanded()}>
          <div
            id={detailsID}
            role="region"
            aria-label={props.row.node.title}
            class="mx-2 mb-2 border-t border-border-weaker-base px-1 pt-2"
          >
            <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-11-regular">
              <dt class="text-text-weak">{language.t("session.agents.details.description")}</dt>
              <dd class="whitespace-pre-wrap break-words text-text-base">
                {props.row.current?.description ?? language.t("common.unknown")}
              </dd>
              <dt class="text-text-weak">{language.t("command.category.agent")}</dt>
              <dd class="break-all text-text-base">
                {props.row.current?.agent ?? props.row.node.agent ?? language.t("common.unknown")}
              </dd>
              <dt class="text-text-weak">{language.t("model.tooltip.model")}</dt>
              <dd class="break-all text-text-base">{model()}</dd>
              <dt class="text-text-weak">{language.t("context.stats.totalTokens")}</dt>
              <dd class="text-text-base">{usageTokens()}</dd>
              <dt class="text-text-weak">{language.t("context.usage.cost")}</dt>
              <dd class="text-text-base">{usageCost()}</dd>
              <For each={times()}>
                {(item) => (
                  <>
                    <dt class="text-text-weak">{item.label}</dt>
                    <dd class="text-text-base">
                      <Show when={item.value} fallback={language.t("common.unknown")}>
                        {(value) => (
                          <time dateTime={timestampISOString(value())}>
                            {formatTimestamp(value(), language.intl())}
                          </time>
                        )}
                      </Show>
                    </dd>
                  </>
                )}
              </For>
              <dt class="text-text-weak">{language.t("session.agents.details.elapsed")}</dt>
              <dd class="text-text-base">
                {formatElapsed(props.row.current, now(), language.intl()) ?? language.t("common.unknown")}
              </dd>
            </dl>
            <p data-slot="agent-run-counts" class="mt-2 text-11-regular text-text-weak">
              {language.t("session.agents.details.runCounts", {
                runs: props.row.runs.length,
                resumes: props.row.resumeCount,
              })}
            </p>
            <Show when={stateDetail()}>
              {(detail) => (
                <p
                  data-slot="agent-state-detail"
                  class="mt-2 whitespace-pre-wrap break-words text-11-regular text-text-base"
                >
                  {detail()}
                </p>
              )}
            </Show>
            <div class="mt-2 flex justify-end">
              <Button
                size="small"
                variant="secondary"
                icon="square-arrow-top-right"
                onClick={() => props.onOpenSession(props.row.node.sessionID)}
              >
                {language.t("session.agents.openSession")}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </li>
  )
}
