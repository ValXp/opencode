import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, on, Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Drawer, DrawerClose, DrawerContent } from "@/components/ui/drawer"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { AgentsPanel } from "./panel"
import { useAgents } from "./context"

export function SessionAgentsDrawer() {
  const agents = useAgents()
  const language = useLanguage()
  const params = useParams<{ id?: string }>()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  createEffect(() => {
    if (!isDesktop()) return
    agents.setMobileDrawerOpen(false)
  })
  createEffect(
    on(
      () => params.id,
      () => agents.setMobileDrawerOpen(false),
      { defer: true },
    ),
  )

  return (
    <Show when={!isDesktop()}>
      <Drawer
        open={agents.mobileDrawerOpen()}
        onOpenChange={agents.setMobileDrawerOpen}
        side={language.direction() === "rtl" ? "left" : "right"}
      >
        <DrawerContent id="session-agents-drawer" aria-label={language.t("settings.agents.title")}>
          <DrawerClose
            as={IconButtonV2}
            type="button"
            size="small"
            variant="ghost-muted"
            class="absolute end-2 top-2 z-10"
            aria-label={language.t("common.close")}
            icon={<Icon name="close-small" />}
          />
          <SessionAgentsPanel class="size-full [&_[data-component=agents-panel]>header]:pe-10" />
        </DrawerContent>
      </Drawer>
    </Show>
  )
}

export function SessionAgentsPanel(props: { class?: string }) {
  const agents = useAgents()
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string }>()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const sync = useSync()

  createEffect(() => {
    const snapshot = agents.snapshot()
    if (!snapshot) return
    snapshot.nodes.forEach((node) => {
      if (sync().session.get(node.sessionID)) return
      void serverSync()
        .session.resolve(node.sessionID)
        .catch(() => {})
    })
  })

  return (
    <Show
      when={!agents.loading() || agents.snapshot()}
      fallback={
        <div
          data-slot="session-agents-loading"
          role="status"
          class={`flex min-h-0 items-center justify-center bg-background-base px-4 py-8 text-12-regular text-text-weak ${props.class ?? ""}`}
        >
          {language.t("common.loading")}
          {language.t("common.loading.ellipsis")}
        </div>
      }
    >
      <div class={`flex min-h-0 flex-col bg-background-base ${props.class ?? ""}`}>
        <Show when={agents.warning() || agents.error()}>
          <div
            data-slot="session-agents-warning"
            role="alert"
            class="flex shrink-0 items-center gap-2 border-b border-border-weaker-base bg-surface-raised-base px-3 py-2 text-11-regular text-text-weak"
          >
            <span class="min-w-0 flex-1 truncate">
              {language.t(agents.error() ? "common.requestFailed" : "common.loading")}
            </span>
            <button
              type="button"
              data-slot="session-agents-retry"
              class="flex size-6 shrink-0 items-center justify-center rounded-md text-icon-base hover:bg-surface-raised-base-hover"
              aria-label={language.t("common.requestFailed")}
              onClick={() => void agents.refresh()}
            >
              <Icon name="reset" size="small" />
            </button>
          </div>
        </Show>
        <AgentsPanel
          class="min-h-0 flex-1"
          projection={agents.projection()}
          historyVisible={agents.showHistory()}
          now={agents.now}
          expanded={agents.expanded}
          onExpandedChange={agents.setExpanded}
          usage={(sessionID) => {
            const session = sync().session.get(sessionID)
            if (!session) return undefined
            return { cost: session.cost, tokens: session.tokens }
          }}
          onHistoryVisibleChange={agents.setShowHistory}
          onOpenSession={(sessionID) => {
            agents.setMobileDrawerOpen(false)
            navigate(
              params.serverKey
                ? sessionHref(requireServerKey(params.serverKey), sessionID)
                : legacySessionHref(sdk().directory, sessionID),
            )
          }}
        />
      </div>
    </Show>
  )
}
