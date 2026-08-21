import {
  findPresentPage,
  matchPresentPageHref,
  useData,
  type PresentPageRegistry,
  type PresentPageRegistryPage,
} from "@opencode-ai/session-ui/context"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { For, Show, createEffect, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSessionLayout } from "@/pages/session/session-layout"

export type PresentPagePanelSelection = {
  page: PresentPageRegistryPage
  href: string
}

export function usePresentPageRegistry() {
  return useData().presentPageRegistry
}

export function resolvePresentPageSelection(
  registry: PresentPageRegistry,
  selection?: { id: string; href?: string },
): PresentPagePanelSelection | undefined {
  const selectedByID = selection ? findPresentPage(registry, selection.id) : undefined
  const selectedByHref = selection?.href ? matchPresentPageHref(registry, selection.href) : undefined
  const page = selectedByID ?? selectedByHref ?? registry.pages[0]
  if (!page) return undefined
  return {
    page,
    href: selection?.href && selectedByHref?.id === page.id ? selection.href : page.url,
  }
}

const shortPageID = (id: string) => `...${id.slice(-8)}`

export function PresentPagePanelView(props: {
  registry: PresentPageRegistry
  selected?: PresentPagePanelSelection
  onSelect: (page: PresentPageRegistryPage) => void
  onOpenExternal: (href: string) => void
  class?: string
}) {
  const language = useLanguage()

  return (
    <section
      data-component="present-page-panel"
      aria-label={language.t("session.presentPage.title")}
      class={`flex min-h-0 flex-col bg-background-base ${props.class ?? ""}`}
    >
      <Show
        when={props.selected}
        fallback={
          <div
            role="status"
            class="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center text-12-regular text-text-weak"
          >
            {language.t("session.presentPage.empty")}
          </div>
        }
      >
        {(selected) => (
          <>
            <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border-weaker-base px-3">
              <div class="min-w-0 flex-1">
                <Show
                  when={props.registry.pages.length > 1}
                  fallback={
                    <div class="truncate text-12-medium text-text-strong">
                      <bdi dir="auto">{selected().page.title}</bdi>
                    </div>
                  }
                >
                  <select
                    data-component="present-page-selector"
                    aria-label={language.t("session.presentPage.selector")}
                    dir="auto"
                    class="h-7 w-full min-w-0 rounded-md border border-border-weaker-base bg-background-base px-2 text-start text-12-regular text-text-strong outline-none focus:border-border-strong-base"
                    value={selected().page.id}
                    onChange={(event) => {
                      const page = props.registry.pages.find((item) => item.id === event.currentTarget.value)
                      if (page) props.onSelect(page)
                    }}
                  >
                    <For each={props.registry.pages}>
                      {(page) => (
                        <option value={page.id} dir="auto">
                          {language.t("session.presentPage.option", {
                            title: page.title,
                            revision: page.currentRevision ?? "?",
                            id: shortPageID(page.id),
                          })}
                        </option>
                      )}
                    </For>
                  </select>
                </Show>
                <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-10-regular text-text-weak">
                  <span>
                    {language.t("session.presentPage.revision", {
                      revision: selected().page.currentRevision ?? "?",
                    })}
                  </span>
                  <span aria-hidden="true">/</span>
                  <bdi dir="ltr" class="truncate">
                    {shortPageID(selected().page.id)}
                  </bdi>
                </div>
              </div>
              <Tooltip value={language.t("session.presentPage.openExternal")} placement="bottom">
                <IconButton
                  icon="square-arrow-top-right"
                  variant="ghost"
                  aria-label={language.t("session.presentPage.openExternal")}
                  onClick={() => props.onOpenExternal(selected().href)}
                />
              </Tooltip>
            </header>
            <iframe
              data-component="present-page-viewer"
              data-page-id={selected().page.id}
              class="min-h-0 w-full flex-1 border-0 bg-background-base"
              src={selected().href}
              title={language.t("session.presentPage.viewerTitle", {
                title: selected().page.title,
                revision: selected().page.currentRevision ?? "?",
              })}
            />
          </>
        )}
      </Show>
    </section>
  )
}

export function SessionPresentPagePanel(props: { class?: string }) {
  const platform = usePlatform()
  const { view } = useSessionLayout()
  const registry = usePresentPageRegistry()
  const selected = createMemo(() => resolvePresentPageSelection(registry(), view().presentPage.selected()))

  createEffect(() => {
    const next = selected()
    if (!next) return
    const current = view().presentPage.selected()
    if (current?.id === next.page.id && current.href === next.href) return
    view().presentPage.select(next.page.id, next.href)
  })

  return (
    <PresentPagePanelView
      registry={registry()}
      selected={selected()}
      onSelect={(page) => view().presentPage.select(page.id, page.url)}
      onOpenExternal={(href) => platform.openExternal(href)}
      class={props.class}
    />
  )
}
