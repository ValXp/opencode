import { describe, expect, test } from "bun:test"
import {
  SESSION_AGENTS_TAB,
  SESSION_OPEN_FILE_TAB,
  SESSION_PRESENT_PAGE_TAB,
  closeSessionTab,
  openSessionTab,
  previewSessionTab,
  type SessionTabState,
} from "./layout-tabs"

const state = (all: string[], active?: string, preview?: string): SessionTabState => ({
  tabs: { all, active },
  preview,
})

describe("previewSessionTab", () => {
  test("never makes Agents replaceable by a file preview", () => {
    const agents = previewSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), SESSION_AGENTS_TAB)

    expect(previewSessionTab(agents, "file://b.ts")).toEqual(
      state([SESSION_AGENTS_TAB, "file://b.ts"], "file://b.ts", "file://b.ts"),
    )
  })

  test("never makes Pages replaceable by a file preview", () => {
    const pages = previewSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), SESSION_PRESENT_PAGE_TAB)

    expect(previewSessionTab(pages, "file://b.ts")).toEqual(
      state([SESSION_PRESENT_PAGE_TAB, "file://b.ts"], "file://b.ts", "file://b.ts"),
    )
  })

  test("appends the Open File placeholder", () => {
    expect(previewSessionTab(state(["file://a.ts"], "file://a.ts"), SESSION_OPEN_FILE_TAB)).toEqual(
      state(["file://a.ts", SESSION_OPEN_FILE_TAB], SESSION_OPEN_FILE_TAB, SESSION_OPEN_FILE_TAB),
    )
  })

  test("replaces the current preview in place", () => {
    expect(
      previewSessionTab(
        state(["context", SESSION_OPEN_FILE_TAB, "file://b.ts"], SESSION_OPEN_FILE_TAB, SESSION_OPEN_FILE_TAB),
        "file://a.ts",
      ),
    ).toEqual(state(["context", "file://a.ts", "file://b.ts"], "file://a.ts", "file://a.ts"))
  })

  test("activates a durable tab without duplicating it", () => {
    expect(
      previewSessionTab(
        state(["file://a.ts", SESSION_OPEN_FILE_TAB, "file://b.ts"], SESSION_OPEN_FILE_TAB, SESSION_OPEN_FILE_TAB),
        "file://b.ts",
      ),
    ).toEqual(state(["file://a.ts", "file://b.ts"], "file://b.ts"))
  })

  test("replaces a restored Open File placeholder", () => {
    expect(
      previewSessionTab(state(["file://a.ts", SESSION_OPEN_FILE_TAB], SESSION_OPEN_FILE_TAB), "file://b.ts"),
    ).toEqual(state(["file://a.ts", "file://b.ts"], "file://b.ts", "file://b.ts"))
  })
})

describe("openSessionTab", () => {
  test("persists Agents without replacing the file preview", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), SESSION_AGENTS_TAB)).toEqual(
      state([SESSION_AGENTS_TAB, "file://a.ts"], SESSION_AGENTS_TAB, "file://a.ts"),
    )
  })

  test("persists Pages without replacing the file preview", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), SESSION_PRESENT_PAGE_TAB)).toEqual(
      state([SESSION_PRESENT_PAGE_TAB, "file://a.ts"], SESSION_PRESENT_PAGE_TAB, "file://a.ts"),
    )
  })

  test("pins the current preview", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), "file://a.ts")).toEqual(
      state(["file://a.ts"], "file://a.ts"),
    )
  })

  test("replaces a preview with a directly opened file", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), "file://b.ts")).toEqual(
      state(["file://b.ts"], "file://b.ts"),
    )
  })

  test("keeps the preview when switching to Review", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), "review")).toEqual(
      state(["file://a.ts"], "review", "file://a.ts"),
    )
  })

  test("replaces a restored Open File placeholder with a direct open", () => {
    expect(openSessionTab(state(["file://a.ts", SESSION_OPEN_FILE_TAB], SESSION_OPEN_FILE_TAB), "file://b.ts")).toEqual(
      state(["file://a.ts", "file://b.ts"], "file://b.ts"),
    )
  })
})

describe("closeSessionTab", () => {
  test("ignores close requests for the persistent Agents workspace", () => {
    const current = state([SESSION_AGENTS_TAB, "file://a.ts"], SESSION_AGENTS_TAB)

    expect(closeSessionTab(current, SESSION_AGENTS_TAB)).toBe(current)
  })

  test("ignores close requests for the persistent Pages workspace", () => {
    const current = state([SESSION_PRESENT_PAGE_TAB, "file://a.ts"], SESSION_PRESENT_PAGE_TAB)

    expect(closeSessionTab(current, SESSION_PRESENT_PAGE_TAB)).toBe(current)
  })

  test("clears preview metadata and selects the left neighbor", () => {
    expect(
      closeSessionTab(
        state(["file://a.ts", "file://b.ts", "file://c.ts"], "file://b.ts", "file://b.ts"),
        "file://b.ts",
      ),
    ).toEqual(state(["file://a.ts", "file://c.ts"], "file://a.ts"))
  })
})
