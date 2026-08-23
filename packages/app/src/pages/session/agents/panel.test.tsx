import { afterEach, describe, expect, test } from "bun:test"
import { Agent, AgentRun, Model, Provider, Session, SessionMessage } from "@opencode-ai/schema"
import { DateTime } from "effect"
import { createSignal } from "solid-js"
import { isServer, render } from "solid-js/web"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { projectAgents, type AgentRow, type AgentsProjection } from "./model"
import { AgentsPanel } from "./panel"

const rootID = Session.ID.make("ses_root")
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

function makeRun(input: {
  id?: string
  sessionID: string
  state: AgentRun.State
  description?: string
  summary?: string
  at?: number
  started?: number | false
  model?: AgentRun.Info["model"]
}) {
  const at = input.at ?? 1_000
  return AgentRun.Info.make({
    id: AgentRun.ID.make(input.id ?? `arun_${input.sessionID}`),
    sessionID: Session.ID.make(input.sessionID),
    callerSessionID: rootID,
    source: {
      messageID: SessionMessage.ID.make(`msg_${input.sessionID}`),
      callID: `call_${input.sessionID}`,
    },
    agent: Agent.ID.make("build"),
    description: input.description ?? `Description for ${input.sessionID}`,
    model: input.model,
    background: true,
    state: input.state,
    activity: {
      at: DateTime.makeUnsafe(at),
      summary: input.summary,
    },
    time: {
      created: DateTime.makeUnsafe(at),
      started:
        input.started === false
          ? undefined
          : DateTime.makeUnsafe(input.started === undefined ? at + 100 : input.started),
      updated: DateTime.makeUnsafe(at + 200),
      finished:
        input.state.type === "running" || input.state.type === "retrying" ? undefined : DateTime.makeUnsafe(at + 300),
    },
    version: 1,
  })
}

function makeRow(input: {
  sessionID: string
  title: string
  state: AgentRun.State
  depth?: number
  summary?: string
  contextOnly?: boolean
  at?: number
  started?: number | false
  model?: AgentRun.Info["model"]
}) {
  const current = makeRun(input)
  return {
    node: AgentRun.Node.make({
      sessionID: Session.ID.make(input.sessionID),
      parentSessionID: rootID,
      title: input.title,
      createdAt: DateTime.makeUnsafe(500),
    }),
    depth: input.depth ?? 0,
    runs: [current],
    current,
    state: current.state,
    active: current.state.type === "running" || current.state.type === "retrying",
    resumeCount: 0,
    contextOnly: input.contextOnly ?? false,
    freshness: undefined,
  } satisfies AgentRow
}

function makeContextRow(sessionID: string, title: string) {
  return {
    node: AgentRun.Node.make({
      sessionID: Session.ID.make(sessionID),
      parentSessionID: rootID,
      title,
      createdAt: DateTime.makeUnsafe(500),
    }),
    depth: 0,
    runs: [],
    current: undefined,
    state: undefined,
    active: false,
    resumeCount: 0,
    contextOnly: true,
    freshness: undefined,
  } satisfies AgentRow
}

function findRow(host: HTMLElement, title: string) {
  const row = Array.from(host.querySelectorAll<HTMLElement>('[data-component="agent-run-row"]')).find((item) =>
    item.textContent?.includes(title),
  )
  if (!row) throw new Error(`Missing agent row: ${title}`)
  return row
}

function pressEnter(button: HTMLButtonElement) {
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }))
  button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }))
}

function mount(
  projection: AgentsProjection | (() => AgentsProjection),
  options?: {
    now?: () => number
    historyVisible?: boolean | (() => boolean)
    expanded?: (sessionID: AgentRow["node"]["sessionID"]) => boolean
    onExpandedChange?: (sessionID: AgentRow["node"]["sessionID"], expanded: boolean) => void
    usage?: (sessionID: AgentRow["node"]["sessionID"]) =>
      | {
          cost?: number
          tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
        }
      | undefined
    awaitingPermission?: (sessionID: AgentRow["node"]["sessionID"]) => boolean
    onHistoryVisibleChange?: (visible: boolean) => void
    onOpenSession?: (sessionID: AgentRow["node"]["sessionID"]) => void
  },
) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    render(
      () => (
        <PlatformProvider value={platform}>
          <LanguageProvider locale="en">
            <AgentsPanel
              projection={typeof projection === "function" ? projection() : projection}
              historyVisible={
                typeof options?.historyVisible === "function" ? options.historyVisible() : options?.historyVisible
              }
              now={options?.now}
              expanded={options?.expanded}
              onExpandedChange={options?.onExpandedChange}
              usage={options?.usage}
              awaitingPermission={options?.awaitingPermission}
              onOpenSession={options?.onOpenSession ?? (() => {})}
              onHistoryVisibleChange={options?.onHistoryVisibleChange ?? (() => {})}
            />
          </LanguageProvider>
        </PlatformProvider>
      ),
      host,
    ),
  )
  return host
}

describe.skipIf(isServer)("AgentsPanel", () => {
  test("renders the compact counts and initial active and history rows", () => {
    const host = mount({
      rows: [
        makeRow({ sessionID: "ses_search", title: "Search code", state: { type: "running" } }),
        makeRow({ sessionID: "ses_tests", title: "Write tests", state: { type: "succeeded" } }),
      ],
      activeCount: 1,
      hiddenHistoryCount: 0,
      totalCount: 2,
    })

    expect(host.textContent).toContain("Agents")
    expect(host.textContent).toContain("1 active · 2 total")
    expect(host.textContent).toContain("Search code")
    expect(host.textContent).toContain("Running")
    expect(host.textContent).toContain("Write tests")
    expect(host.textContent).toContain("Succeeded")
  })

  test("preserves nested indentation and subdues context-only ancestors", () => {
    const host = mount({
      rows: [
        makeContextRow("ses_ancestor", "Earlier coordinator"),
        makeRow({
          sessionID: "ses_nested",
          title: "Nested worker",
          state: { type: "running" },
          depth: 1,
        }),
      ],
      activeCount: 1,
      hiddenHistoryCount: 0,
      totalCount: 2,
    })
    const ancestor = findRow(host, "Earlier coordinator")
    const nested = findRow(host, "Nested worker")

    expect(ancestor.dataset.contextOnly).toBe("true")
    expect(ancestor.classList.contains("opacity-60")).toBe(true)
    expect(ancestor.textContent).toContain("Context")
    expect(ancestor.textContent).not.toContain("Unknown")
    expect(nested.dataset.depth).toBe("1")
    expect(Number.parseInt(nested.style.paddingInlineStart)).toBeGreaterThan(
      Number.parseInt(ancestor.style.paddingInlineStart),
    )
    expect(nested.style.paddingLeft).toBe("")
  })

  test("presents every authoritative run state", () => {
    const states: Array<{ title: string; state: AgentRun.State; label: string }> = [
      { title: "Worker one", state: { type: "running" }, label: "Running" },
      {
        title: "Worker two",
        state: { type: "retrying", attempt: 2, message: "Rate limited", next: DateTime.makeUnsafe(5_000) },
        label: "Retrying",
      },
      { title: "Worker three", state: { type: "succeeded" }, label: "Succeeded" },
      { title: "Worker four", state: { type: "failed", error: "Build failed" }, label: "Failed" },
      { title: "Worker five", state: { type: "cancelled" }, label: "Cancelled" },
      { title: "Worker six", state: { type: "interrupted", reason: "User stopped" }, label: "Interrupted" },
      { title: "Worker seven", state: { type: "unknown", reason: "owner_lost" }, label: "Unknown" },
    ]
    const host = mount({
      rows: states.map((item, index) => makeRow({ sessionID: `ses_state_${index}`, ...item })),
      activeCount: 2,
      hiddenHistoryCount: 0,
      totalCount: states.length,
    })

    states.forEach((item) => {
      const row = findRow(host, item.title)
      expect(row.dataset.state).toBe(item.state.type)
      expect(row.textContent).toContain(item.label)
    })
  })

  test("shows matching active agents as awaiting permission instead of inactive", () => {
    const waiting = makeRow({
      sessionID: "ses_waiting",
      title: "Waiting worker",
      state: { type: "running" },
      summary: "Reading secrets",
      at: 0,
      started: 1,
    })
    const sibling = makeRow({
      sessionID: "ses_sibling",
      title: "Sibling worker",
      state: { type: "running" },
      summary: "Running tests",
      at: 0,
      started: 1,
    })
    const finished = makeRow({
      sessionID: "ses_finished",
      title: "Finished worker",
      state: { type: "succeeded" },
    })
    const snapshot = AgentRun.Snapshot.make({
      rootSessionID: rootID,
      nodes: [waiting.node, sibling.node, finished.node],
      active: [waiting.current!, sibling.current!],
      history: [finished.current!],
    })
    const [pending, setPending] = createSignal(new Set(["ses_waiting", "ses_finished", String(rootID)]))
    const host = mount(projectAgents(snapshot, { now: 120_000, showHistory: true }), {
      awaitingPermission: (sessionID) => pending().has(String(sessionID)),
    })
    const waitingRow = findRow(host, "Waiting worker")

    expect(waitingRow.textContent).toContain("Awaiting permission")
    expect(waitingRow.textContent).not.toContain("No activity")
    expect(waitingRow.querySelector('[data-slot="agent-status-live"]')?.textContent).toBe("Awaiting permission")
    expect(findRow(host, "Sibling worker").textContent).toContain("No activity for 1m 59s")
    expect(findRow(host, "Finished worker").textContent).toContain("Succeeded")
    expect(findRow(host, "Finished worker").textContent).not.toContain("Awaiting permission")

    setPending(new Set<string>())

    expect(waitingRow.textContent).toContain("Running")
    expect(waitingRow.textContent).toContain("No activity for 1m 59s")
    expect(waitingRow.querySelector('[data-slot="agent-status-live"]')?.textContent).toBe("Running")
  })

  test("switches the semantic activity line at the 60 second inactivity boundary", () => {
    const [now, setNow] = createSignal(59_999)
    const base = makeRow({
      sessionID: "ses_quiet",
      title: "Quiet worker",
      state: { type: "running" },
      summary: "Indexing symbols",
      at: 0,
      started: 1,
    })
    const snapshot = AgentRun.Snapshot.make({
      rootSessionID: rootID,
      nodes: [base.node],
      active: [base.current!],
      history: [],
    })
    const [projection, setProjection] = createSignal(projectAgents(snapshot, { now: 60_000 }))
    const host = mount(projection, { now })
    const row = findRow(host, "Quiet worker")

    expect(row.textContent).toContain("Indexing symbols")
    expect(row.textContent).not.toContain("No activity")
    expect(row.querySelector('[data-slot="agent-activity"]')?.hasAttribute("aria-live")).toBe(false)
    expect(row.querySelector('[data-slot="agent-activity-live"]')?.getAttribute("aria-live")).toBe("polite")
    expect(row.querySelector('[data-slot="agent-activity-live"]')?.textContent).toBe("Indexing symbols")

    setNow(60_001)
    setProjection(projectAgents(snapshot, { now: 60_001 }))
    expect(findRow(host, "Quiet worker").textContent).toContain("No activity for 1m · Last: Indexing symbols")
    expect(row.querySelector('[data-slot="agent-activity-live"]')?.textContent).toBe("Indexing symbols")

    setNow(61_001)
    setProjection(projectAgents(snapshot, { now: 61_001 }))
    expect(findRow(host, "Quiet worker").textContent).toContain("No activity for 1m 1s · Last: Indexing symbols")
    expect(row.querySelector('[data-slot="agent-activity-live"]')?.textContent).toBe("Indexing symbols")

    setNow(3_600_001)
    setProjection(projectAgents(snapshot, { now: 3_600_001 }))
    expect(findRow(host, "Quiet worker").textContent).toContain("No activity for 1h · Last: Indexing symbols")
  })

  test("does not mark queued runs inactive and ages newly started runs from their start", () => {
    const [now, setNow] = createSignal(300_000)
    const row = makeRow({
      sessionID: "ses_queued",
      title: "Queued worker",
      state: { type: "running" },
      summary: "Waiting to start",
      at: 0,
      started: false,
    })
    const [current, setCurrent] = createSignal(row.current!)
    const projection = () =>
      projectAgents(
        AgentRun.Snapshot.make({ rootSessionID: rootID, nodes: [row.node], active: [current()], history: [] }),
        { now: now() },
      )
    const host = mount(projection, { now })
    const element = findRow(host, "Queued worker")

    expect(element.textContent).toContain("Waiting to start")
    expect(element.textContent).not.toContain("No activity")

    const started = DateTime.makeUnsafe(300_000)
    setCurrent({ ...current(), time: { ...current().time, started } })
    setNow(359_999)
    expect(findRow(host, "Queued worker").textContent).not.toContain("No activity")

    setNow(360_000)
    expect(findRow(host, "Queued worker").textContent).toContain("No activity for 1m · Last: Waiting to start")
  })

  test("expands and collapses by click and opens the child session explicitly", () => {
    const base = makeRow({
      sessionID: "ses_detail",
      title: "Detailed worker",
      state: { type: "running" },
      at: 1_000,
    })
    const previous = makeRun({
      id: "arun_detail_previous",
      sessionID: "ses_detail",
      state: { type: "succeeded" },
      at: 500,
    })
    const opened: string[] = []
    const host = mount(
      {
        rows: [{ ...base, runs: [base.current, previous], resumeCount: 1 }],
        activeCount: 1,
        hiddenHistoryCount: 0,
        totalCount: 1,
      },
      { now: () => 6_100, onOpenSession: (sessionID) => opened.push(String(sessionID)) },
    )
    const row = findRow(host, "Detailed worker")
    const disclosure = row.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
    expect(disclosure).toBeDefined()
    expect(row.textContent).not.toContain("Description for ses_detail")

    disclosure?.click()
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true")
    expect(row.textContent).toContain("Description for ses_detail")
    expect(row.textContent).toContain("Agentbuild")
    expect(row.textContent).toContain("Created")
    expect(row.textContent).toContain("Started")
    expect(row.textContent).toContain("Updated")
    expect(row.textContent).toContain("Finishedunknown")
    expect(row.textContent).toContain("Elapsed5s")
    expect(row.textContent).toContain("Runs: 2 · Resumes: 1")

    disclosure?.click()
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false")

    disclosure?.click()
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true")

    const open = Array.from(row.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Open session"),
    )
    open?.click()
    expect(opened).toEqual(["ses_detail"])
  })

  test("expands exactly once for one native keyboard activation", () => {
    const host = mount({
      rows: [makeRow({ sessionID: "ses_keyboard", title: "Keyboard worker", state: { type: "running" } })],
      activeCount: 1,
      hiddenHistoryCount: 0,
      totalCount: 1,
    })
    const row = findRow(host, "Keyboard worker")
    const disclosure = row.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
    if (!disclosure) throw new Error("Missing keyboard disclosure")

    pressEnter(disclosure)

    expect(disclosure.getAttribute("aria-expanded")).toBe("true")
    expect(row.querySelectorAll('[role="region"]')).toHaveLength(1)
  })

  test("supports externally controlled expansion", () => {
    const [expanded, setExpanded] = createSignal(false)
    const changes: Array<[string, boolean]> = []
    const host = mount(
      {
        rows: [makeRow({ sessionID: "ses_controlled", title: "Controlled worker", state: { type: "running" } })],
        activeCount: 1,
        hiddenHistoryCount: 0,
        totalCount: 1,
      },
      {
        expanded: () => expanded(),
        onExpandedChange(sessionID, value) {
          changes.push([String(sessionID), value])
        },
      },
    )
    const row = findRow(host, "Controlled worker")
    const disclosure = row.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
    if (!disclosure) throw new Error("Missing controlled disclosure")

    disclosure.click()
    expect(changes).toEqual([["ses_controlled", true]])
    expect(disclosure.getAttribute("aria-expanded")).toBe("false")

    setExpanded(true)
    expect(disclosure.getAttribute("aria-expanded")).toBe("true")

    disclosure.click()
    expect(changes).toEqual([
      ["ses_controlled", true],
      ["ses_controlled", false],
    ])
    expect(disclosure.getAttribute("aria-expanded")).toBe("true")

    setExpanded(false)
    expect(disclosure.getAttribute("aria-expanded")).toBe("false")
  })

  test("never applies inactivity treatment to terminal rows", () => {
    const states: AgentRun.State[] = [
      { type: "succeeded" },
      { type: "failed", error: "Failed" },
      { type: "cancelled" },
      { type: "interrupted", reason: "Stopped" },
      { type: "unknown", reason: "orphaned" },
    ]
    const host = mount(
      {
        rows: states.map((state, index) =>
          makeRow({
            sessionID: `ses_terminal_${index}`,
            title: `Terminal worker ${index}`,
            state,
            summary: `Final activity ${index}`,
            at: 0,
          }),
        ),
        activeCount: 0,
        hiddenHistoryCount: 0,
        totalCount: states.length,
      },
      { now: () => 90_000 },
    )

    states.forEach((_, index) => {
      const activity = findRow(host, `Terminal worker ${index}`).querySelector('[data-slot="agent-activity"]')
      expect(activity?.textContent).toBe(`Final activity ${index}`)
      expect(activity?.textContent).not.toContain("No activity")
    })
  })

  test("requests history projections and updates the history label", () => {
    const [historyVisible, setHistoryVisible] = createSignal(false)
    const hidden = makeRow({ sessionID: "ses_hidden", title: "Older worker", state: { type: "succeeded" } })
    const limited: AgentsProjection = {
      rows: [makeRow({ sessionID: "ses_recent", title: "Recent worker", state: { type: "succeeded" } })],
      activeCount: 0,
      hiddenHistoryCount: 2,
      totalCount: 3,
    }
    const expanded: AgentsProjection = {
      ...limited,
      rows: [...limited.rows, hidden],
    }
    const changes: boolean[] = []
    const host = mount(() => (historyVisible() ? expanded : limited), {
      historyVisible,
      onHistoryVisibleChange(visible) {
        changes.push(visible)
        setHistoryVisible(visible)
      },
    })

    expect(host.textContent).not.toContain("Older worker")
    const show = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show history (2)"),
    )
    expect(show).toBeDefined()

    show?.click()
    expect(changes).toEqual([true])
    expect(host.textContent).toContain("Older worker")
    const hide = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Hide history"),
    )
    expect(hide).toBeDefined()

    hide?.click()
    expect(changes).toEqual([true, false])
    expect(host.textContent).not.toContain("Older worker")
  })

  test("shows model, retry, error, and reason details", () => {
    const rows = [
      makeRow({
        sessionID: "ses_retry",
        title: "Retry worker",
        state: { type: "retrying", attempt: 3, message: "Rate limited", next: DateTime.makeUnsafe(10_000) },
        model: Model.Ref.make({
          providerID: Provider.ID.make("anthropic"),
          id: Model.ID.make("claude-sonnet"),
          variant: Model.VariantID.make("high"),
        }),
      }),
      makeRow({
        sessionID: "ses_failure",
        title: "Failure worker",
        state: { type: "failed", error: "Compiler exploded" },
      }),
      makeRow({
        sessionID: "ses_interruption",
        title: "Interruption worker",
        state: { type: "interrupted", reason: "User requested stop" },
      }),
      makeRow({
        sessionID: "ses_unknown",
        title: "Unknown worker",
        state: { type: "unknown", reason: "owner_lost" },
      }),
    ]
    const host = mount({
      rows,
      activeCount: 1,
      hiddenHistoryCount: 0,
      totalCount: rows.length,
    })
    rows.forEach((row) => findRow(host, row.node.title).querySelector<HTMLButtonElement>("button")?.click())

    expect(findRow(host, "Retry worker").textContent).toContain("anthropic/claude-sonnet (high)")
    expect(findRow(host, "Retry worker").textContent).toContain("Attempt 3 · Rate limited · Next:")
    expect(findRow(host, "Failure worker").textContent).toContain("Error: Compiler exploded")
    expect(findRow(host, "Interruption worker").textContent).toContain("Reason: User requested stop")
    expect(findRow(host, "Unknown worker").textContent).toContain("Reason: owner_lost")
  })

  test("shows authoritative session usage including zero cost and unknown fallbacks", () => {
    const rows = [
      makeRow({ sessionID: "ses_usage", title: "Usage worker", state: { type: "succeeded" } }),
      makeRow({ sessionID: "ses_no_usage", title: "Unknown usage worker", state: { type: "succeeded" } }),
    ]
    const host = mount(
      {
        rows,
        activeCount: 0,
        hiddenHistoryCount: 0,
        totalCount: rows.length,
      },
      {
        usage: (sessionID) =>
          String(sessionID) === "ses_usage"
            ? {
                cost: 0,
                tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
              }
            : undefined,
      },
    )
    rows.forEach((row) => findRow(host, row.node.title).querySelector<HTMLButtonElement>("button")?.click())

    expect(findRow(host, "Usage worker").textContent).toContain("Total Tokens132")
    expect(findRow(host, "Usage worker").textContent).toContain("Cost$0.00")
    expect(findRow(host, "Unknown usage worker").textContent).toContain("Total Tokensunknown")
    expect(findRow(host, "Unknown usage worker").textContent).toContain("Costunknown")
  })

  test("renders a localized empty state for an empty projection", () => {
    const host = mount({ rows: [], activeCount: 0, hiddenHistoryCount: 0, totalCount: 0 })

    expect(host.querySelector('[role="status"]')?.textContent).toBe("No agent sessions yet")
    expect(host.querySelectorAll('[data-component="agent-run-row"]')).toHaveLength(0)
  })
})
