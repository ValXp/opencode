import { createUniqueId, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { codexUsageStale, createSharedCodexUsageState, supportsCodexUsage } from "@/utils/codex-usage"

export function CodexUsageIndicator(props: { directory?: string; compact?: boolean }) {
  const sdk = useServerSDK()
  const platform = usePlatform()
  const state = createSharedCodexUsageState(() => {
    if (!supportsCodexUsage(platform.platform)) return
    const server = sdk()
    return {
      server: server.server.http,
      directory: props.directory,
      subscribe: (invalidate: () => void) =>
        server.event.listen((event) => {
          if (event.details.type === "integration.connection.updated" || event.details.type === "integration.updated")
            invalidate()
        }),
    }
  }, platform.fetch ?? globalThis.fetch)
  return <CodexUsageDisplay state={state} compact={props.compact} />
}

export function CodexUsageDisplay(props: { state: ReturnType<typeof createSharedCodexUsageState>; compact?: boolean }) {
  const language = useLanguage()
  const state = props.state
  const description = createUniqueId()
  const [focus, setFocus] = createStore({ active: false })
  const stale = () => {
    const usage = state.usage
    return usage && codexUsageStale(usage, state.now) ? usage.updatedAt : undefined
  }

  const label = () => {
    const usage = state.usage
    if (!usage || usage.status === "unknown" || !usage.windows.length)
      return language.t("settings.providers.codexUsage.compactUnknown")
    const percent = Math.floor(Math.min(...usage.windows.map((window) => window.remainingPercent)))
    return language.t(
      codexUsageStale(usage, state.now)
        ? "settings.providers.codexUsage.compactStale"
        : "settings.providers.codexUsage.compact",
      { percent },
    )
  }

  const detail = () => (
    <div
      id={description}
      class="basis-full flex flex-col gap-1 text-12-regular text-text-weak"
      data-component="codex-usage"
      role="status"
    >
      <bdi dir="auto" class="text-text-base">
        {language.t("settings.providers.codexUsage.title")}
      </bdi>
      <Show when={props.compact && (state.usage?.windows.length ?? 0) > 1}>
        <bdi dir="auto">{language.t("settings.providers.codexUsage.minimum")}</bdi>
      </Show>
      <Show when={props.compact && state.usage && codexUsageStale(state.usage, state.now) && !stale()}>
        <bdi dir="auto">{language.t("settings.providers.codexUsage.lastKnown")}</bdi>
      </Show>
      <Show when={stale()}>
        {(time) => (
          <bdi dir="auto">
            {language.t("settings.providers.codexUsage.stale", {
              time: new Date(time()).toLocaleString(language.intl()),
            })}
          </bdi>
        )}
      </Show>
      <Show when={state.usage?.limitReached || state.usage?.allowed === false}>
        <bdi dir="auto">{language.t("settings.providers.codexUsage.limited")}</bdi>
      </Show>
      <For
        each={state.usage?.windows}
        fallback={<bdi dir="auto">{language.t("settings.providers.codexUsage.unknown")}</bdi>}
      >
        {(window) => (
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            <bdi dir="auto">
              {language.t(
                window.windowSeconds === 604800
                  ? "settings.providers.codexUsage.weekly"
                  : "settings.providers.codexUsage.remaining",
                {
                  percent: Math.floor(window.remainingPercent),
                  hours: Math.round((window.windowSeconds / 3600) * 10) / 10,
                },
              )}
            </bdi>
            <bdi dir="auto">
              {window.resetAt == null
                ? language.t("settings.providers.codexUsage.resetUnknown")
                : language.t("settings.providers.codexUsage.reset", {
                    time: new Date(window.resetAt).toLocaleString(language.intl()),
                  })}
            </bdi>
          </div>
        )}
      </For>
    </div>
  )

  return (
    <Show when={state.capable && state.usage && state.usage.status !== "unsupported"}>
      <Show when={props.compact} fallback={detail()}>
        <Tooltip placement="bottom" value={detail()} forceOpen={focus.active}>
          <button
            type="button"
            data-component="codex-usage-compact"
            class="shrink-0 whitespace-nowrap rounded px-1 text-11-medium tabular-nums text-text-weak focus-visible:outline focus-visible:outline-2"
            aria-label={label()}
            aria-describedby={description}
            onFocus={() => setFocus("active", true)}
            onBlur={() => setFocus("active", false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFocus("active", false)
            }}
          >
            <bdi>{label()}</bdi>
          </button>
        </Tooltip>
      </Show>
    </Show>
  )
}
