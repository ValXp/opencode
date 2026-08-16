import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/PowerSavings"

test("persists power saving mode and disables repaint-heavy effects", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_power_savings",
      worktree: directory,
      vcs: "git",
      name: "power-savings",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    if (!localStorage.getItem("settings.v3")) {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: true } }),
      )
    }
  })

  await page.goto("/")
  const autoplayVideo = page.locator('video[aria-hidden="true"]')
  await expect(autoplayVideo).toHaveCount(1)
  await page.keyboard.press("Control+,")

  const setting = page.locator('[data-action="settings-power-savings"]')
  const input = setting.getByRole("switch", { name: "Power saving mode" })
  await expect(setting).toBeVisible()
  await expect(input).not.toBeChecked()
  await setting.locator('[data-slot="switch-control"]').click()

  await expect(input).toBeChecked()
  await expect(page.locator("html")).toHaveAttribute("data-power-savings", "")
  await expect(autoplayVideo).toHaveCount(0)
  await expect.poll(() => readPreference(page)).toBe(true)

  expect(
    await page.evaluate(async () => {
      const probe = document.createElement("div")
      probe.style.animation = "spin 1s linear infinite"
      probe.style.transition = "opacity 1s linear"
      probe.style.filter = "blur(4px)"
      probe.style.backdropFilter = "blur(4px)"
      document.body.append(probe)
      const reveal = document.createElement("span")
      reveal.dataset.component = "text-reveal"
      const entering = document.createElement("span")
      entering.dataset.slot = "text-reveal-entering"
      entering.style.maskImage = "linear-gradient(white, transparent)"
      const leaving = document.createElement("span")
      leaving.dataset.slot = "text-reveal-leaving"
      reveal.append(entering, leaving)
      document.body.append(reveal)
      const number = document.createElement("span")
      number.dataset.component = "animated-number"
      const strip = document.createElement("span")
      strip.dataset.slot = "animated-number-strip"
      strip.dataset.animating = "true"
      strip.style.transform = "translateY(0px)"
      number.append(strip)
      document.body.append(number)
      const style = getComputedStyle(probe)
      const numberTransition = getComputedStyle(strip).transitionProperty
      const numberTransitionEnded = await new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), 100)
        strip.addEventListener(
          "transitionend",
          () => {
            window.clearTimeout(timeout)
            resolve(true)
          },
          { once: true },
        )
        strip.getBoundingClientRect()
        requestAnimationFrame(() => {
          strip.style.transform = "translateY(1px)"
        })
      })
      const result = {
        animationName: style.animationName,
        transitionProperty: style.transitionProperty,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        filter: style.filter,
        backdropFilter: style.backdropFilter,
        revealMask: getComputedStyle(entering).maskImage,
        leavingDisplay: getComputedStyle(leaving).display,
        numberTransition,
        numberTransitionEnded,
      }
      probe.remove()
      reveal.remove()
      number.remove()
      return result
    }),
  ).toEqual({
    animationName: "none",
    transitionProperty: "none",
    scrollBehavior: "auto",
    filter: "none",
    backdropFilter: "none",
    revealMask: "none",
    leavingDisplay: "none",
    numberTransition: "transform",
    numberTransitionEnded: true,
  })

  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-power-savings", "")
  await page.keyboard.press("Control+,")
  const restored = page.locator('[data-action="settings-power-savings"]')
  await expect(restored.getByRole("switch", { name: "Power saving mode" })).toBeChecked()
  await expect(autoplayVideo).toHaveCount(0)

  await restored.locator('[data-slot="switch-control"]').click()
  await expect(page.locator("html")).not.toHaveAttribute("data-power-savings")
  await expect(autoplayVideo).toHaveCount(1)
  await expect.poll(() => readPreference(page)).toBe(false)
})

function readPreference(page: import("@playwright/test").Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3") ?? "{}").general?.powerSavings)
}
