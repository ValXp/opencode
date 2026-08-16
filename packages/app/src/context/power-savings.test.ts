import { describe, expect, test } from "bun:test"
import { isMotionDisabled } from "@opencode-ai/ui/motion-spring"
import {
  powerSavingsMotionDuration,
  powerSavingsPreference,
  powerSavingsScrollBehavior,
  setPowerSavingsMode,
} from "./power-savings"

describe("power saving mode", () => {
  test("defaults older settings to disabled", () => {
    expect(powerSavingsPreference(undefined)).toBe(false)
    expect(powerSavingsPreference({})).toBe(false)
    expect(powerSavingsPreference({ powerSavings: false })).toBe(false)
    expect(powerSavingsPreference({ powerSavings: true })).toBe(true)
  })

  test("toggles the browser rendering policy", () => {
    const root = document.documentElement
    root.removeAttribute("data-power-savings")

    setPowerSavingsMode(root, true)
    expect(root.hasAttribute("data-power-savings")).toBe(true)
    expect(isMotionDisabled()).toBe(true)

    setPowerSavingsMode(root, false)
    expect(root.hasAttribute("data-power-savings")).toBe(false)
    expect(isMotionDisabled()).toBe(false)
  })

  test("uses immediate scrolling while enabled", () => {
    expect(powerSavingsScrollBehavior(true)).toBe("auto")
    expect(powerSavingsScrollBehavior(false)).toBe("smooth")
  })

  test("snaps application motion while enabled", () => {
    expect(powerSavingsMotionDuration(true, 0.3)).toBe(0)
    expect(powerSavingsMotionDuration(false, 0.3)).toBe(0.3)
  })
})
