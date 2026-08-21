import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/SessionAgentsPanel"
const otherDirectory = "C:/OpenCode/SessionAgentsPanelOther"
const projectID = "proj_session_agents_panel"
const rootID = "ses_agents_root"
const childID = "ses_agents_child"
const otherRootID = "ses_agents_other_root"
const otherChildID = "ses_agents_other_child"
const rootTitle = "Agents root session"
const childTitle = "Focused child agent"
const otherChildTitle = "Agent from another session"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const layouts = [
  { name: "new layout", enabled: true },
  { name: "legacy layout", enabled: false },
] as const

test.use({ viewport: { width: 1440, height: 900 } })

test("keeps the agents provider mounted before the workspace tab opens", async ({ page }) => {
  test.setTimeout(120_000)
  let requests = 0
  await setup(page, {
    agentRun: (sessionID) => {
      requests++
      return { body: snapshot(sessionID) }
    },
  })

  await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })

  await expect.poll(() => requests).toBe(1)
  await expect(page.locator("#review-panel")).toHaveCount(0)
  await expect(page.locator('[data-component="agents-panel"]')).toHaveCount(0)
})

test("repairs the snapshot after a locationless global reconnect event", async ({ page }) => {
  let requests = 0
  let connections = 0
  await setup(page, {
    agentRun: (sessionID) => {
      requests++
      return {
        body: snapshot(
          sessionID,
          requests === 1
            ? run({ state: { type: "running" }, version: 1 })
            : run({ state: { type: "succeeded" }, version: 2 }),
        ),
      }
    },
  })
  await page.route(
    (url) => url.pathname === "/api/event",
    (route) => {
      connections++
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          id: connections === 1 ? "evt_agents_initial" : "evt_agents_reconnect",
          type: "server.connected",
          data: {},
        })}\n\n`,
      })
    },
  )

  await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })

  await expect.poll(() => connections).toBeGreaterThanOrEqual(2)
  await expect.poll(() => requests).toBe(2)
  await expect(page.locator('[data-slot="session-agents-header-trigger"]')).toHaveAttribute("data-active-count", "0")
})

test("shows the active agent count in the persistent header while the workspace is closed", async ({ page }) => {
  await setup(page, { agentRun: (sessionID) => ({ body: snapshot(sessionID) }) })

  await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })

  const trigger = page.locator('[data-slot="session-agents-header-trigger"]')
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute("data-active-count", "1")
  await expect(page.locator("#review-panel")).toHaveCount(0)
})

for (const layout of layouts) {
  test(`shows active agents from every session tree and opens a cross-directory session in the ${layout.name}`, async ({
    page,
  }) => {
    const other = run({
      id: "arun_agents_other_child",
      sessionID: otherChildID,
      callerSessionID: otherRootID,
      description: "Work in another root session",
      state: { type: "running" },
      version: 1,
    })
    await setup(page, {
      agentRun: (sessionID) => ({ body: snapshot(sessionID) }),
      agentRunOverview: () => ({ body: overview(run({ state: { type: "running" }, version: 1 }), other) }),
      sessions: [
        session(otherRootID, "Other root session", 1_700_000_003_000, { directory: otherDirectory }),
        session(otherChildID, otherChildTitle, 1_700_000_004_000, {
          directory: otherDirectory,
          parentID: otherRootID,
        }),
      ],
      newLayoutDesigns: layout.enabled,
    })

    await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })

    const trigger = page.locator('[data-slot="session-agents-header-trigger"]')
    await expect(trigger).toHaveAttribute("data-active-count", "2")
    await trigger.click()

    const panel = page.locator('[data-component="agents-panel"]')
    await expect(panel.locator('[data-component="agent-run-row"]')).toHaveCount(2)
    await expect(panel).toContainText(childTitle)
    await expect(panel).toContainText(otherChildTitle)

    const row = panel.getByRole("listitem").filter({ hasText: otherChildTitle })
    await row.getByRole("button", { name: new RegExp(otherChildTitle) }).click()
    await row.getByRole("button", { name: "Open session" }).click()

    await expect(page).toHaveURL(
      layout.enabled
        ? new RegExp(`/server/[^/]+/session/${otherChildID}$`)
        : new RegExp(`/${base64Encode(otherDirectory)}/session/${otherChildID}$`),
    )
    await expect(page.getByRole("heading", { name: otherChildTitle })).toBeVisible()
  })
}

for (const layout of layouts) {
  test(`keeps the Agents workspace tab available without using the header indicator in the ${layout.name}`, async ({
    page,
  }) => {
    await setup(page, {
      agentRun: (sessionID) => ({ body: snapshot(sessionID) }),
      newLayoutDesigns: layout.enabled,
    })

    await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })

    await page.getByRole("button", { name: "Toggle review" }).click()
    const tab = page.getByRole("tab", { name: "Agents" })
    await expect(tab).toBeVisible()
    await expect(tab.locator('[data-slot="tabs-trigger-close-button"]')).toHaveCount(0)

    await tab.click()
    await expect(page.locator('[data-component="agents-panel"]')).toBeVisible()

    await page.getByRole("tab", { name: "Review" }).click()
    await expect(tab).toBeVisible()
    await tab.click()
    await expect(page.locator('[data-component="agents-panel"]')).toBeVisible()

    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(page.locator("#review-panel")).toHaveCount(0)
    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(page.getByRole("tab", { name: "Agents" })).toBeVisible()
  })

  test(`opens the persistent agents workspace tab from the desktop header in the ${layout.name}`, async ({ page }) => {
    await setup(page, {
      agentRun: (sessionID) => ({ body: snapshot(sessionID) }),
      newLayoutDesigns: layout.enabled,
    })

    await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })

    const trigger = page.locator('[data-slot="session-agents-header-trigger"]')
    await expect(trigger).toHaveCount(1)
    await expect(trigger).toHaveAttribute("aria-controls", "review-panel")
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    if (!layout.enabled) await expect(page.getByRole("button", { name: "Toggle terminal" })).toBeVisible()
    await trigger.click()

    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator("#review-panel")).toHaveAttribute("aria-hidden", "false")
    const tab = page.getByRole("tab", { name: "Agents" })
    await expect(tab).toBeVisible()
    await expect(tab.locator('[data-slot="tabs-trigger-close-button"]')).toHaveCount(0)
    await expect(page.locator('[data-component="agents-panel"]')).toBeVisible()

    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(page.locator("#review-panel")).toHaveCount(0)
    await trigger.click()
    await expect(page.locator('[data-component="agents-panel"]')).toBeVisible()
  })
}

test("shows synchronized child usage and opens the child on the target server", async ({ page }) => {
  await setup(page, { agentRun: (sessionID) => ({ body: snapshot(sessionID) }) })

  await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })
  await page.locator('[data-slot="session-agents-header-trigger"]').click()

  const row = page.locator('[data-component="agent-run-row"]')
  await row.locator("button").first().click()
  await expect(row).toContainText("137")
  await expect(row).toContainText("$1.25")

  await row.getByRole("button", { name: "Open session" }).click()
  await expect(page).toHaveURL(new RegExp(`/server/[^/]+/session/${childID}$`))
  await expect(page.getByRole("heading", { name: childTitle })).toBeVisible()
})

test("shows loading while the initial agent snapshot is pending", async ({ page }) => {
  const response = Promise.withResolvers<{ body: unknown; status?: number }>()
  await setup(page, { agentRun: () => response.promise })

  await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })
  await page.locator('[data-slot="session-agents-header-trigger"]').click()

  await expect(page.locator('[data-slot="session-agents-loading"]')).toBeVisible()
  response.resolve({ body: snapshot() })
  await expect(page.locator('[data-component="agent-run-row"]')).toBeVisible()
  await expect(page.locator('[data-slot="session-agents-loading"]')).toHaveCount(0)
})

test("keeps stale agent data visible and retries after a repair failure", async ({ page }) => {
  const repair = Promise.withResolvers<void>()
  let requests = 0
  let recovered = false
  await setup(page, {
    agentRun: (sessionID) => {
      requests++
      if (requests === 1) return { body: snapshot(sessionID) }
      if (recovered) return { body: snapshotWithUnknown(sessionID) }
      return { body: { error: "temporarily unavailable" }, status: 503 }
    },
  })
  await page.route(
    (url) => url.pathname === "/api/event",
    async (route) => {
      await repair.promise
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          id: "evt_agents_reconnect",
          created: 1_700_000_003_000,
          type: "agent.run.updated",
          data: {
            info: {
              ...unknownRun(),
            },
          },
          location: { directory },
        })}\n\n`,
      })
    },
  )

  await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })
  await page.locator('[data-slot="session-agents-header-trigger"]').click()
  await expect(page.locator('[data-component="agent-run-row"]')).toBeVisible()

  repair.resolve()
  await expect.poll(() => requests).toBe(2)
  await expect(page.locator('[data-slot="session-agents-warning"]')).toBeVisible()
  await expect(page.locator('[data-component="agent-run-row"]')).toBeVisible()

  recovered = true
  await page.locator('[data-slot="session-agents-retry"]').click()
  await expect.poll(() => requests).toBe(3)
  await expect(page.locator('[data-slot="session-agents-warning"]')).toHaveCount(0)
})

for (const layout of layouts) {
  test(`opens a mobile agents drawer in the ${layout.name} and closes it when navigating to a child`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setup(page, {
      agentRun: (sessionID) => ({ body: snapshot(sessionID) }),
      newLayoutDesigns: layout.enabled,
    })

    await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })
    const trigger = page.locator('[data-slot="session-agents-header-trigger"]')
    await expect(trigger).toHaveCount(1)
    await expect(trigger).toHaveAttribute("aria-controls", "session-agents-drawer")
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    if (!layout.enabled) await expect(page.getByRole("button", { name: "Toggle terminal" })).toBeVisible()
    await trigger.click()

    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    const drawer = page.getByRole("dialog", { name: "Agents" })
    await expect(drawer).toHaveId("session-agents-drawer")
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('[data-component="agents-panel"]')).toBeVisible()
    await expect(page.locator("#review-panel")).toHaveCount(0)

    const row = drawer.locator('[data-component="agent-run-row"]')
    await row.getByRole("button", { name: new RegExp(childTitle) }).click()
    await row.getByRole("button", { name: "Open session" }).click()

    await expect(page).toHaveURL(
      layout.enabled
        ? new RegExp(`/server/[^/]+/session/${childID}$`)
        : new RegExp(`/${base64Encode(directory)}/session/${childID}$`),
    )
    await expect(page.getByRole("heading", { name: childTitle })).toBeVisible()
    await expect(drawer).toHaveCount(0)
  })
}

test("anchors the mobile agents drawer and nested hierarchy to logical end in forced RTL", async ({ page }) => {
  await setup(page, {
    agentRun: (sessionID) => {
      const current = snapshot(sessionID)
      return {
        body: {
          ...current,
          nodes: [
            {
              sessionID: "ses_agents_coordinator",
              parentSessionID: rootID,
              title: "Coordinator agent",
              agent: "build",
              createdAt: 1_700_000_000_500,
            },
            { ...current.nodes[0], parentSessionID: "ses_agents_coordinator" },
          ],
        },
      }
    },
  })

  await page.goto(sessionHref(rootID), { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 60_000 })
  await page.getByRole("button", { name: "DIR: LTR" }).click()
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await page.getByRole("button", { name: "Toggle review" }).click()
  await expect(page.getByRole("tab", { name: "Agents" })).toBeVisible()
  await page.getByRole("button", { name: "Toggle review" }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-slot="session-agents-header-trigger"]').click()

  const drawer = page.getByRole("dialog", { name: "Agents" })
  await expect(drawer).toHaveAttribute("data-side", "left")
  await expect(drawer).toHaveCSS("left", "6px")
  const summary = drawer.locator('[data-slot="agents-summary"]')
  await expect(summary).toHaveAttribute("dir", "auto")
  await expect.poll(() => summary.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr")
  const row = drawer.getByRole("listitem").filter({ hasText: childTitle })
  const title = row.locator('[data-slot="agent-title"]')
  await expect(title).toHaveAttribute("dir", "auto")
  await expect.poll(() => title.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr")
  const activity = row.locator('[data-slot="agent-activity"]')
  await expect(activity).not.toHaveAttribute("dir", "auto")
  await expect.poll(() => activity.evaluate((element) => getComputedStyle(element).direction)).toBe("rtl")
  await expect(activity).toHaveCSS("padding-right", "24px")
  const activityText = activity.locator('[data-slot="agent-activity-text"]')
  await expect(activityText).toHaveAttribute("dir", "auto")
  await expect.poll(() => activityText.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr")
  await expect.poll(() => row.evaluate((element) => getComputedStyle(element).paddingInlineStart)).toBe("20px")
  await expect.poll(() => activity.evaluate((element) => getComputedStyle(element).paddingInlineStart)).toBe("24px")
})

async function setup(
  page: Page,
  input: {
    agentRun: (sessionID: string) => { body: unknown; status?: number } | Promise<{ body: unknown; status?: number }>
    agentRunOverview?: () => { body: unknown; status?: number } | Promise<{ body: unknown; status?: number }>
    sessions?: ({ id: string } & Record<string, unknown>)[]
    newLayoutDesigns?: boolean
  },
) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-agents-panel",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      session(rootID, rootTitle, 1_700_000_000_000),
      session(childID, childTitle, 1_700_000_001_000, {
        parentID: rootID,
        cost: 1.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
      }),
      ...(input.sessions ?? []),
    ],
    pageMessages: () => ({ items: [] }),
    agentRun: input.agentRun,
    agentRunOverview: input.agentRunOverview ?? (() => input.agentRun(rootID)),
  })
  await page.route(
    (url) => ["/api/provider", "/api/model", "/api/model/default"].includes(url.pathname),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ data: route.request().url().includes("/default") ? null : [] }),
      }),
  )
  await page.addInitScript(
    ({ directory, server, sessionID, newLayoutDesigns }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns } }))
      if (!newLayoutDesigns) localStorage.setItem("app-version.v1", JSON.stringify({ version: "999.0.0" }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID: rootID, newLayoutDesigns: input.newLayoutDesigns ?? true },
  )
}

function session(id: string, title: string, created: number, extra?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
    ...extra,
  }
}

function snapshot(sessionID = rootID, info = run({ state: { type: "running" }, version: 1 })) {
  return {
    rootSessionID: sessionID,
    nodes: [
      {
        sessionID: childID,
        parentSessionID: rootID,
        title: childTitle,
        agent: "build",
        createdAt: 1_700_000_001_000,
      },
    ],
    active: info.state.type === "running" || info.state.type === "retrying" ? [info] : [],
    history: info.state.type === "running" || info.state.type === "retrying" ? [] : [info],
  }
}

function overview(...active: ReturnType<typeof run>[]) {
  return {
    nodes: [
      {
        sessionID: childID,
        parentSessionID: rootID,
        title: childTitle,
        agent: "build",
        createdAt: 1_700_000_001_000,
      },
      {
        sessionID: otherChildID,
        parentSessionID: otherRootID,
        title: otherChildTitle,
        agent: "build",
        createdAt: 1_700_000_004_000,
      },
    ],
    active,
    history: [],
  }
}

function snapshotWithUnknown(sessionID = rootID) {
  const current = snapshot(sessionID)
  return {
    ...current,
    nodes: [
      ...current.nodes,
      {
        sessionID: "ses_agents_unknown",
        parentSessionID: rootID,
        title: "Unknown child agent",
        agent: "build",
        createdAt: 1_700_000_003_000,
      },
    ],
    active: [...current.active, unknownRun()],
  }
}

function unknownRun() {
  return {
    ...run({ state: { type: "running" }, version: 1 }),
    id: "arun_agents_unknown",
    sessionID: "ses_agents_unknown",
  }
}

function run(input: {
  state: Record<string, unknown>
  version: number
  id?: string
  sessionID?: string
  callerSessionID?: string
  description?: string
}) {
  return {
    id: input.id ?? "arun_agents_child",
    sessionID: input.sessionID ?? childID,
    callerSessionID: input.callerSessionID ?? rootID,
    source: { messageID: "msg_agents_child", callID: "call_agents_child" },
    agent: "build",
    description: input.description ?? "Inspect the final app integration",
    model: { providerID: "opencode", id: "test" },
    background: true,
    state: input.state,
    activity: { at: 1_700_000_002_000, summary: "Checking integration behavior" },
    time: {
      created: 1_700_000_001_000,
      started: 1_700_000_001_100,
      updated: 1_700_000_002_000,
    },
    version: input.version,
  }
}

function sessionHref(sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
