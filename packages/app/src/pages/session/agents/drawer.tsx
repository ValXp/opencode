import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, on, Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Drawer, DrawerClose, DrawerContent } from "@/components/ui/drawer"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { AgentsPanel } from "./panel"
import { useAgents } from "./context"

export async function resolveLegacyAgentSessionHref(input: {
  sessionID: string
  getSession: (sessionID: string) => { directory: string } | undefined
  resolveSession: (sessionID: string) => Promise<{ directory: string }>
}) {
  const session = input.getSession(input.sessionID) ?? (await input.resolveSession(input.sessionID))
  return legacySessionHref(session.directory, input.sessionID)
}

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
  const session = agents.session
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string }>()
  const serverSync = useServerSync()
  const sync = useSync()

  createEffect(() => {
    const overview = session.overview()
    if (!overview) return
    overview.nodes.forEach((node) => {
      if (serverSync().session.get(node.sessionID)) return
      void serverSync()
        .session.resolve(node.sessionID)
        .catch(() => {})
    })
  })

  return (
    <Show
      when={!session.loading() || session.overview()}
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
        <Show when={agents.warning() || agents.error() || session.warning() || session.error()}>
          <div
            data-slot="session-agents-warning"
            role="alert"
            class="flex shrink-0 items-center gap-2 border-b border-border-weaker-base bg-surface-raised-base px-3 py-2 text-11-regular text-text-weak"
          >
            <span class="min-w-0 flex-1 truncate">
              {language.t(agents.error() || session.error() ? "common.requestFailed" : "common.loading")}
            </span>
            <button
              type="button"
              data-slot="session-agents-retry"
              class="flex size-6 shrink-0 items-center justify-center rounded-md text-icon-base hover:bg-surface-raised-base-hover"
              aria-label={language.t("common.requestFailed")}
              onClick={() => void Promise.all([agents.refresh(), session.refresh()])}
            >
              <Icon name="reset" size="small" />
            </button>
          </div>
        </Show>
        <AgentsPanel
          class="min-h-0 flex-1"
          projection={session.projection()}
          historyVisible={session.showHistory()}
          now={session.now}
          expanded={session.expanded}
          onExpandedChange={session.setExpanded}
          usage={(sessionID) => {
            const session = sync().session.get(sessionID)
            if (!session) return undefined
            return { cost: session.cost, tokens: session.tokens }
          }}
          awaitingPermission={(sessionID) => (sync().data.permission[sessionID]?.length ?? 0) > 0}
          onHistoryVisibleChange={session.setShowHistory}
          onOpenSession={(sessionID) => {
            agents.setMobileDrawerOpen(false)
            if (params.serverKey) {
              navigate(sessionHref(requireServerKey(params.serverKey), sessionID))
              return
            }
            void resolveLegacyAgentSessionHref({
              sessionID,
              getSession: (id) => serverSync().session.get(id),
              resolveSession: (id) => serverSync().session.resolve(id),
            })
              .then((href) => navigate(href))
              .catch(() => {})
          }}
        />
      </div>
    </Show>
  )
}
