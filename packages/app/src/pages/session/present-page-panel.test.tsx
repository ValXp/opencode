import { afterEach, describe, expect, test } from "bun:test"
import type { PresentPageRegistry, PresentPageRegistryPage } from "@opencode-ai/session-ui/context"
import { isServer, render } from "solid-js/web"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { PresentPagePanelView, resolvePresentPageSelection } from "./present-page-panel"

const first: PresentPageRegistryPage = {
  id: "page_alpha_12345678",
  currentRevision: 3,
  title: "Shared title",
  url: "https://pages.test/p/page_alpha_12345678",
  revisionUrl: "https://pages.test/p/page_alpha_12345678/revisions/3",
  hrefs: [
    "https://pages.test/p/page_alpha_12345678",
    "https://pages.test/p/page_alpha_12345678/revisions/2",
    "https://pages.test/p/page_alpha_12345678/revisions/3",
  ],
}
const second: PresentPageRegistryPage = {
  id: "page_beta_87654321",
  currentRevision: 1,
  title: "Shared title",
  url: "https://pages.test/p/page_beta_87654321",
  revisionUrl: "https://pages.test/p/page_beta_87654321/revisions/1",
  hrefs: ["https://pages.test/p/page_beta_87654321", "https://pages.test/p/page_beta_87654321/revisions/1"],
}
const registry: PresentPageRegistry = { pages: [first, second] }
const cleanups: Array<() => void> = []
const platform: Platform = {
  platform: "web",
  openExternal() {},
  restart: async () => {},
  notify: async () => {},
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

describe("resolvePresentPageSelection", () => {
  test("defaults to the first page and preserves a recognized immutable href", () => {
    expect(resolvePresentPageSelection(registry)).toEqual({ page: first, href: first.url })
    expect(
      resolvePresentPageSelection(registry, {
        id: first.id,
        href: "https://pages.test/p/page_alpha_12345678/revisions/2#section",
      }),
    ).toEqual({ page: first, href: "https://pages.test/p/page_alpha_12345678/revisions/2#section" })
    expect(resolvePresentPageSelection(registry, { id: "missing", href: "https://pages.test/missing" })).toEqual({
      page: first,
      href: first.url,
    })
  })
})

describe.skipIf(isServer)("PresentPagePanelView", () => {
  test("distinguishes selector options, selects current URLs, and opens the displayed revision", () => {
    const selected: string[] = []
    const opened: string[] = []
    const immutable = "about:blank#present-page-revision-2"
    const host = document.createElement("div")
    document.body.append(host)
    cleanups.push(
      render(
        () => (
          <PlatformProvider value={platform}>
            <LanguageProvider locale="en">
              <PresentPagePanelView
                registry={registry}
                selected={{ page: first, href: immutable }}
                onSelect={(page) => selected.push(`${page.id}:${page.url}`)}
                onOpenExternal={(href) => opened.push(href)}
              />
            </LanguageProvider>
          </PlatformProvider>
        ),
        host,
      ),
    )

    const selector = host.querySelector<HTMLSelectElement>('[data-component="present-page-selector"]')
    const options = Array.from(selector?.options ?? []).map((option) => option.textContent)
    expect(options).toEqual([
      "Shared title - Revision 3 - ...12345678",
      "Shared title - Revision 1 - ...87654321",
    ])

    if (!selector) throw new Error("Missing page selector")
    expect(selector.getAttribute("dir")).toBe("auto")
    expect(Array.from(selector.options).every((option) => option.getAttribute("dir") === "auto")).toBe(true)
    selector.value = second.id
    selector.dispatchEvent(new Event("change", { bubbles: true }))
    expect(selected).toEqual([`${second.id}:${second.url}`])

    const iframe = host.querySelector<HTMLIFrameElement>('[data-component="present-page-viewer"]')
    expect(iframe?.getAttribute("src")).toBe(immutable)
    expect(host.querySelector('bdi[dir="ltr"]')?.textContent?.trim()).toBe("...12345678")

    host.querySelector<HTMLButtonElement>('button[aria-label="Open page in browser"]')?.click()
    expect(opened).toEqual([immutable])
  })
})
