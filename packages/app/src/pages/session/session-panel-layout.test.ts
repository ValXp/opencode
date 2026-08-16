import { describe, expect, test } from "bun:test"
import { sessionPanelLayout } from "./session-panel-layout"

describe("sessionPanelLayout", () => {
  test("stacks the terminal below whichever workspace is visible", () => {
    expect(sessionPanelLayout({ workspace: false, terminal: false })).toEqual({
      visible: false,
      stacked: false,
    })
    expect(sessionPanelLayout({ workspace: false, terminal: true })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(sessionPanelLayout({ workspace: true, terminal: false })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(sessionPanelLayout({ workspace: true, terminal: true })).toEqual({
      visible: true,
      stacked: true,
    })
  })
})
