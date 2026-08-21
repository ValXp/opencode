import { describe, expect, test } from "bun:test"
import type { PresentPageRegistry } from "../context"
import {
  getPresentPageOpenRequest,
  getPresentPageToolCard,
  isUnmodifiedPrimaryClick,
  openPresentPageFromClick,
} from "./present-page-tool"

const current = "https://pages.test/p/page_alpha_12345678"
const immutable = `${current}/revisions/6`
const registry: PresentPageRegistry = {
  pages: [
    {
      id: "page_alpha_12345678",
      currentRevision: 6,
      title: "Quarterly plan",
      url: current,
      revisionUrl: immutable,
      hrefs: [current, immutable],
    },
  ],
}
const metadata = {
  schemaVersion: 1,
  ok: true,
  page: {
    id: "page_alpha_12345678",
    currentRevision: 6,
    title: "Quarterly plan",
    url: current,
    revisionUrl: immutable,
  },
}

describe("getPresentPageToolCard", () => {
  test("uses only successful completed metadata and links the interactive current page", () => {
    expect(getPresentPageToolCard("completed", metadata)).toEqual({
      pageID: "page_alpha_12345678",
      title: "Quarterly plan",
      revision: 6,
      href: current,
    })
    expect(getPresentPageToolCard("running", metadata)).toBeUndefined()
    expect(getPresentPageToolCard("completed", { ...metadata, ok: false })).toBeUndefined()
    expect(getPresentPageToolCard("completed", { ...metadata, schemaVersion: 2 })).toBeUndefined()
  })
})

describe("Present Page open interactions", () => {
  test("matches current and immutable Markdown hrefs while preserving the clicked href", () => {
    expect(getPresentPageOpenRequest(registry, current)).toEqual({
      pageID: "page_alpha_12345678",
      href: current,
    })
    expect(getPresentPageOpenRequest(registry, `${immutable}#section`)).toEqual({
      pageID: "page_alpha_12345678",
      href: `${immutable}#section`,
    })
    expect(getPresentPageOpenRequest(registry, "https://pages.test/p/page_unknown")).toBeUndefined()
  })

  test("opens only unmodified primary activations", () => {
    const base = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    expect(isUnmodifiedPrimaryClick({ ...base, preventDefault() {} })).toBe(true)
    expect(isUnmodifiedPrimaryClick({ ...base, button: 1, preventDefault() {} })).toBe(false)
    expect(isUnmodifiedPrimaryClick({ ...base, ctrlKey: true, preventDefault() {} })).toBe(false)
    expect(isUnmodifiedPrimaryClick({ ...base, metaKey: true, preventDefault() {} })).toBe(false)
    expect(isUnmodifiedPrimaryClick({ ...base, shiftKey: true, preventDefault() {} })).toBe(false)
    expect(isUnmodifiedPrimaryClick({ ...base, altKey: true, preventDefault() {} })).toBe(false)

    const opened: string[] = []
    let prevented = false
    const request = { pageID: "page_alpha_12345678", href: immutable }
    expect(
      openPresentPageFromClick(
        { ...base, preventDefault: () => (prevented = true) },
        request,
        (value) => opened.push(`${value.pageID}:${value.href}`),
      ),
    ).toBe(true)
    expect(prevented).toBe(true)
    expect(opened).toEqual([`page_alpha_12345678:${immutable}`])

    prevented = false
    expect(
      openPresentPageFromClick(
        { ...base, button: 1, preventDefault: () => (prevented = true) },
        request,
        () => opened.push("unexpected"),
      ),
    ).toBe(false)
    expect(prevented).toBe(false)
    expect(opened).toHaveLength(1)

    expect(openPresentPageFromClick({ ...base, preventDefault: () => (prevented = true) }, request, undefined)).toBe(
      false,
    )
    expect(prevented).toBe(false)
  })
})
