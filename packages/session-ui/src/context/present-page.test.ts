import { describe, expect, test } from "bun:test"
import {
  getPresentPageRegistry,
  matchPresentPageHref,
  parsePresentPageMarkdown,
  parsePresentPageMetadata,
  type PresentPage,
} from "./present-page"

const metadata = (page: PresentPage) => ({
  schemaVersion: 1,
  ok: true,
  operation: "publish:revise",
  page: { ...page, pinned: false, lifecycle: "active" },
})

const page = (id: string, currentRevision: number, title = id): PresentPage => ({
  id,
  currentRevision,
  title,
  url: `https://pages.test/p/${id}`,
  revisionUrl: `https://pages.test/p/${id}/revisions/${currentRevision}`,
})

const completed = (sessionID: string, value: unknown, tool = "present_page") => ({
  type: "tool",
  sessionID,
  tool,
  state: {
    status: "completed",
    metadata: value,
    output: JSON.stringify(value),
  },
})

const message = (id: string, role: "assistant" | "user", created: number) => ({ id, role, time: { created } })

describe("parsePresentPageMetadata", () => {
  test("accepts only the successful v1 page envelope and strips unrelated fields", () => {
    expect(parsePresentPageMetadata(metadata(page("page_alpha", 2, "Alpha")))).toEqual({
      schemaVersion: 1,
      ok: true,
      page: page("page_alpha", 2, "Alpha"),
    })

    expect(parsePresentPageMetadata({ ...metadata(page("page_alpha", 2)), ok: false })).toBeUndefined()
    expect(parsePresentPageMetadata({ ...metadata(page("page_alpha", 2)), schemaVersion: 2 })).toBeUndefined()
    expect(
      parsePresentPageMetadata({
        ...metadata(page("page_alpha", 2)),
        page: { ...page("page_alpha", 2), currentRevision: "2" },
      }),
    ).toBeUndefined()
    expect(
      parsePresentPageMetadata({
        ...metadata(page("page_alpha", 2)),
        page: { ...page("page_alpha", 2), revisionUrl: undefined },
      }),
    ).toBeUndefined()
  })
})

describe("parsePresentPageMarkdown", () => {
  test("recognizes only narrow current and immutable page links", () => {
    expect(
      parsePresentPageMarkdown(
        [
          "Open [Quarterly plan](https://pages.test/p/page_alpha-123/revisions/12).",
          "Current: <http://localhost:4173/p/page_beta_456>.",
          "Ignore https://pages.test/pages/page_wrong and https://pages.test/p/page_wrong/extra.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        id: "page_alpha-123",
        currentRevision: 12,
        title: "Quarterly plan",
        url: "https://pages.test/p/page_alpha-123",
        revisionUrl: "https://pages.test/p/page_alpha-123/revisions/12",
        hrefs: ["https://pages.test/p/page_alpha-123/revisions/12"],
      },
      {
        id: "page_beta_456",
        currentRevision: undefined,
        title: "page_beta_456",
        url: "http://localhost:4173/p/page_beta_456",
        revisionUrl: undefined,
        hrefs: ["http://localhost:4173/p/page_beta_456"],
      },
    ])
  })
})

describe("getPresentPageRegistry", () => {
  test("keeps a useful current-link title when a generic immutable link supplies the revision", () => {
    const registry = getPresentPageRegistry({
      sessionID: "session-root",
      sessions: [{ id: "session-root" }],
      messages: {
        "session-root": [message("message-root-assistant", "assistant", 100)],
      },
      parts: {
        "message-root-assistant": [
          {
            type: "text",
            sessionID: "session-root",
            text: [
              "[Quarterly launch plan](https://pages.test/p/page_launch_12345678)",
              "[revision 6](https://pages.test/p/page_launch_12345678/revisions/6)",
            ].join("\n"),
          },
        ],
      },
    })

    expect(registry.pages).toEqual([
      {
        id: "page_launch_12345678",
        currentRevision: 6,
        title: "Quarterly launch plan",
        url: "https://pages.test/p/page_launch_12345678",
        revisionUrl: "https://pages.test/p/page_launch_12345678/revisions/6",
        hrefs: [
          "https://pages.test/p/page_launch_12345678",
          "https://pages.test/p/page_launch_12345678/revisions/6",
        ],
      },
    ])
  })

  test("scans loaded descendants and uses root assistant Markdown only when metadata is absent", () => {
    const first = page("page_child_12345678", 1, "Child page")
    const revised = page("page_child_12345678", 3, "Revised child page")
    const authoritative = page("page_authoritative_87654321", 6, "Authoritative title")
    const registry = getPresentPageRegistry({
      sessionID: "session-root",
      sessions: [
        { id: "session-root" },
        { id: "session-child", parentID: "session-root" },
        { id: "session-grandchild", parentID: "session-child" },
        { id: "session-other" },
        { id: "session-sibling", parentID: "session-other" },
        { id: "session-orphan", parentID: "session-missing" },
      ],
      messages: {
        "session-root": [message("message-root-assistant", "assistant", 100), message("message-root-user", "user", 110)],
        "session-child": [message("message-child", "assistant", 120)],
        "session-grandchild": [message("message-grandchild", "assistant", 130)],
        "session-sibling": [message("message-sibling", "assistant", 140)],
        "session-orphan": [message("message-orphan", "assistant", 150)],
      },
      parts: {
        "message-root-assistant": [
          {
            type: "text",
            sessionID: "session-root",
            text: [
              "[Fallback board](https://pages.test/p/page_fallback_11223344/revisions/4)",
              "https://pages.test/p/page_fallback_11223344",
              "[Live board](https://pages.test/p/page_current_44332211)",
              "[Returned label](https://pages.test/p/page_authoritative_87654321/revisions/1)",
            ].join("\n"),
          },
          {
            type: "tool",
            sessionID: "session-root",
            state: {
              status: "completed",
              metadata: {},
              output: "https://pages.test/p/page_tool_output/revisions/9",
            },
          },
        ],
        "message-root-user": [
          {
            type: "text",
            sessionID: "session-root",
            text: "https://pages.test/p/page_user_text/revisions/7",
          },
        ],
        "message-child": [
          {
            type: "text",
            sessionID: "session-child",
            text: "https://pages.test/p/page_descendant_text/revisions/8",
          },
          completed("session-child", metadata(first), "delegated_present_page"),
        ],
        "message-grandchild": [
          completed("session-grandchild", metadata(revised)),
          completed("session-grandchild", metadata(authoritative)),
        ],
        "message-sibling": [completed("session-sibling", metadata(page("page_sibling", 9)))],
        "message-orphan": [completed("session-orphan", metadata(page("page_orphan", 9)))],
      },
    })

    expect(registry.pages.map((item) => item.id)).toEqual([
      authoritative.id,
      revised.id,
      "page_current_44332211",
      "page_fallback_11223344",
    ])
    expect(registry.pages.find((item) => item.id === revised.id)).toEqual({
      ...revised,
      hrefs: [first.url, first.revisionUrl, revised.revisionUrl],
    })
    expect(registry.pages.find((item) => item.id === authoritative.id)).toEqual({
      ...authoritative,
      hrefs: [
        authoritative.url,
        authoritative.revisionUrl,
        "https://pages.test/p/page_authoritative_87654321/revisions/1",
      ],
    })
    expect(registry.pages.find((item) => item.id === "page_fallback_11223344")).toEqual({
      id: "page_fallback_11223344",
      currentRevision: 4,
      title: "Fallback board",
      url: "https://pages.test/p/page_fallback_11223344",
      revisionUrl: "https://pages.test/p/page_fallback_11223344/revisions/4",
      hrefs: [
        "https://pages.test/p/page_fallback_11223344/revisions/4",
        "https://pages.test/p/page_fallback_11223344",
      ],
    })
    expect(registry.pages.find((item) => item.id === "page_current_44332211")?.currentRevision).toBeUndefined()
    expect(registry.pages.some((item) => item.id === "page_sibling")).toBe(false)
    expect(registry.pages.some((item) => item.id === "page_orphan")).toBe(false)
    expect(registry.pages.some((item) => item.id === "page_user_text")).toBe(false)
    expect(registry.pages.some((item) => item.id === "page_descendant_text")).toBe(false)
    expect(registry.pages.some((item) => item.id === "page_tool_output")).toBe(false)
    expect(matchPresentPageHref(registry, `${first.revisionUrl}#details`)?.id).toBe(first.id)
    expect(matchPresentPageHref(registry, authoritative.url)?.id).toBe(authoritative.id)
    expect(
      matchPresentPageHref(registry, "https://pages.test/p/page_authoritative_87654321/revisions/1")?.id,
    ).toBe(authoritative.id)
    expect(matchPresentPageHref(registry, "https://pages.test/p/missing")).toBeUndefined()
  })
})
