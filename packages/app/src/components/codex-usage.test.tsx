import { afterEach, expect, test } from "bun:test"
import { render, isServer } from "solid-js/web"
import { createStore } from "solid-js/store"
import type { CodexUsage } from "@opencode-ai/schema/codex-usage"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { CodexUsageDisplay } from "./codex-usage"

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

function mount(direction: "ltr" | "rtl", compact = true) {
  const host = document.createElement("div")
  host.dir = direction
  document.body.append(host)
  const [state, setState] = createStore<{ capable: boolean; usage: CodexUsage.Info; now: number }>({
    capable: true,
    now: 1000,
    usage: {
      status: "fresh",
      updatedAt: 1000,
      windows: [{ kind: "primary", remainingPercent: 58, windowSeconds: 604800 }],
    },
  })
  cleanups.push(
    render(
      () => (
        <PlatformProvider
          value={{ platform: "web", openExternal() {}, restart: async () => {}, notify: async () => {} }}
        >
          <LanguageProvider>
            <CodexUsageDisplay state={state} compact={compact} />
          </LanguageProvider>
        </PlatformProvider>
      ),
      host,
    ),
  )
  return { host, setState }
}

test.skipIf(isServer)(
  "weekly primary is not inferred to be a short window; compact is focusable and bidi-isolated",
  () => {
    for (const direction of ["ltr", "rtl"] as const) {
      const view = mount(direction)
      const button = view.host.querySelector("button")!
      expect(button.textContent).toBe("58%")
      expect(button.getAttribute("aria-label")).toBe("Codex 58% remaining")
      expect(button.querySelector("bdi")?.dir).toBe("ltr")
      button.focus()
      expect(document.activeElement).toBe(button)
    }
    const detail = mount("rtl", false)
    expect(detail.host.textContent).toContain("58% remaining · weekly window")
    expect(detail.host.textContent).not.toContain("5h")
    expect(detail.host.textContent).toContain("Reset time unavailable")
    const phrases = [...detail.host.querySelectorAll("bdi")]
    expect(phrases.length).toBeGreaterThan(2)
    expect(phrases.every((phrase) => phrase.dir === "auto")).toBe(true)
    expect(getComputedStyle(phrases[1]).direction).toBe("ltr")
  },
)

test.skipIf(isServer)("most constrained window, stale and unavailable labels, and unsupported hiding", () => {
  const view = mount("ltr")
  view.setState("usage", {
    status: "fresh",
    updatedAt: 1000,
    windows: [
      { kind: "primary", remainingPercent: 80, windowSeconds: 18000 },
      { kind: "secondary", remainingPercent: 24.9, windowSeconds: 604800 },
    ],
  })
  expect(view.host.textContent).toBe("24%")
  expect(view.host.querySelector("button")!.getAttribute("aria-label")).toBe("Codex 24% remaining")
  view.setState("now", 92000)
  expect(view.host.textContent).toBe("24%")
  expect(view.host.querySelector("button")!.getAttribute("aria-label")).toBe("Codex 24% · stale")
  view.setState("usage", { status: "unknown", windows: [] })
  expect(view.host.textContent).toBe("—")
  expect(view.host.querySelector("button")!.getAttribute("aria-label")).toBe("Codex —")
  view.setState("usage", { status: "fresh", windows: [{ kind: "primary", remainingPercent: 0, windowSeconds: 18000 }] })
  expect(view.host.textContent).toBe("0%")
  view.setState("usage", { status: "unsupported", windows: [] })
  expect(view.host.querySelector("button")).toBeNull()
  view.setState("capable", false)
  expect(view.host.textContent).toBe("")
})

test.skipIf(isServer)("keyboard tooltip describes both windows, reset times and access limits", async () => {
  const view = mount("rtl")
  view.setState("usage", {
    status: "fresh",
    updatedAt: 1000,
    allowed: false,
    windows: [
      { kind: "primary", remainingPercent: 80, windowSeconds: 18000, resetAt: 100000 },
      { kind: "secondary", remainingPercent: 58, windowSeconds: 604800 },
    ],
  })
  const button = view.host.querySelector("button")!
  button.focus()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const description = document.getElementById(button.getAttribute("aria-describedby")!)
  expect(description).not.toBeNull()
  expect(description!.textContent).toContain("80% remaining · 5h window")
  expect(description!.textContent).toContain("58% remaining · weekly window")
  expect(description!.textContent).toContain("Shows the lowest remaining percentage across windows.")
  expect(description!.textContent).toContain("Resets")
  expect(description!.textContent).toContain("Subscription limit reached or access unavailable")
  expect([...description!.querySelectorAll("bdi")].every((phrase) => phrase.dir === "auto")).toBe(true)
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(document.querySelector('[data-component="tooltip"][data-force-open="true"]')).toBeNull()
})
