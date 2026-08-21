export type PresentPage = {
  id: string
  currentRevision: number
  title: string
  url: string
  revisionUrl: string
}

export type PresentPageMetadata = {
  schemaVersion: 1
  ok: true
  page: PresentPage
}

export type PresentPageRegistryPage = {
  id: string
  currentRevision?: number
  title: string
  url: string
  revisionUrl?: string
  hrefs: readonly string[]
}

export type PresentPageRegistry = {
  pages: readonly PresentPageRegistryPage[]
}

export type PresentPageRegistryInput = {
  sessionID: string
  sessions: readonly { id: string; parentID?: string }[]
  messages: Readonly<
    Record<string, readonly { id: string; role: string; time: { created: number } }[] | undefined>
  >
  parts: Readonly<Record<string, readonly unknown[] | undefined>>
}

const PRESENT_PAGE_URL =
  /https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/p\/([A-Za-z0-9_-]+)(?:\/revisions\/([1-9][0-9]*))?(?=$|[\s<>)\]"'`,.!?#])/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0

export function parsePresentPageMetadata(value: unknown): PresentPageMetadata | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.ok !== true || !isRecord(value.page)) return undefined
  if (!isText(value.page.id) || !isText(value.page.title)) return undefined
  if (!isText(value.page.url) || !isText(value.page.revisionUrl)) return undefined
  const currentRevision = value.page.currentRevision
  if (typeof currentRevision !== "number" || !Number.isInteger(currentRevision) || currentRevision < 1) return undefined

  return {
    schemaVersion: 1,
    ok: true,
    page: {
      id: value.page.id,
      currentRevision,
      title: value.page.title,
      url: value.page.url,
      revisionUrl: value.page.revisionUrl,
    },
  }
}

export function parsePresentPageMarkdown(markdown: string): PresentPageRegistryPage[] {
  return Array.from(markdown.matchAll(PRESENT_PAGE_URL)).map((match) => {
    const id = match[1]
    const revision = match[2] ? Number.parseInt(match[2], 10) : undefined
    const href = match[0]
    const revisionPath = revision ? `/revisions/${revision}` : undefined
    const label = markdown
      .slice(Math.max(0, (match.index ?? 0) - 500), match.index)
      .match(/\[([^\]\n]+)\]\(<?$/)?.[1]
      ?.trim()

    return {
      id,
      currentRevision: revision,
      title: label || id,
      url: revisionPath ? href.slice(0, href.length - revisionPath.length) : href,
      revisionUrl: revision ? href : undefined,
      hrefs: [href],
    }
  })
}

export function getPresentPageRegistry(input: PresentPageRegistryInput): PresentPageRegistry {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const sessionIDs = new Set([
    input.sessionID,
    ...input.sessions
      .filter((session) => reachesSession(session.id, input.sessionID, sessions))
      .map((session) => session.id),
  ])
  const messages = Array.from(sessionIDs)
    .flatMap((sessionID, sessionIndex) =>
      (input.messages[sessionID] ?? []).map((message, messageIndex) => ({
        message,
        sessionID,
        sequence: sessionIndex * 1_000_000 + messageIndex,
      })),
    )
    .sort((a, b) => a.message.time.created - b.message.time.created || a.sequence - b.sequence)

  const metadata = messages.flatMap((entry, messageIndex) =>
    (input.parts[entry.message.id] ?? []).flatMap((part, partIndex) => {
      if (!isRecord(part) || part.type !== "tool" || part.sessionID !== entry.sessionID) return []
      if (!isRecord(part.state) || part.state.status !== "completed") return []
      const result = parsePresentPageMetadata(part.state.metadata)
      if (!result) return []
      return [
        {
          page: {
            ...result.page,
            hrefs: [result.page.url, result.page.revisionUrl],
          } satisfies PresentPageRegistryPage,
          messageIndex,
          partIndex,
          linkIndex: 0,
          source: "metadata" as const,
        },
      ]
    }),
  )
  const metadataIDs = new Set(metadata.map((item) => item.page.id))
  const markdown = messages.flatMap((entry, messageIndex) => {
    if (entry.sessionID !== input.sessionID || entry.message.role !== "assistant") return []
    return (input.parts[entry.message.id] ?? []).flatMap((part, partIndex) => {
      if (!isRecord(part) || part.type !== "text" || part.sessionID !== input.sessionID || !isText(part.text)) return []
      return parsePresentPageMarkdown(part.text)
        .map((page, linkIndex) => ({ page, messageIndex, partIndex, linkIndex, source: "markdown" as const }))
    })
  })
  const markdownHrefs = markdown.reduce((result, item) => {
    result.set(item.page.id, [...(result.get(item.page.id) ?? []), ...item.page.hrefs])
    return result
  }, new Map<string, string[]>())
  const observed = [
    ...metadata.map((item) => ({
      ...item,
      page: {
        ...item.page,
        hrefs: Array.from(new Set([...item.page.hrefs, ...(markdownHrefs.get(item.page.id) ?? [])])),
      },
    })),
    ...markdown.filter((item) => !metadataIDs.has(item.page.id)),
  ].sort(
    (a, b) =>
      a.messageIndex - b.messageIndex || a.partIndex - b.partIndex || a.linkIndex - b.linkIndex,
  )

  const pages = observed.reduce(
    (result, observation, index) => {
      const current = result.get(observation.page.id)
      const latest =
        !current || (observation.page.currentRevision ?? 0) >= (current.currentRevision ?? 0)
          ? observation.page
          : current
      const title =
        latest === observation.page &&
        observation.source === "markdown" &&
        isGenericMarkdownTitle(observation.page) &&
        current &&
        !isGenericMarkdownTitle(current)
          ? current.title
          : latest.title
      result.set(observation.page.id, {
        ...latest,
        title,
        hrefs: Array.from(new Set([...(current?.hrefs ?? []), ...observation.page.hrefs])),
        observed: index,
      })
      return result
    },
    new Map<string, PresentPageRegistryPage & { observed: number }>(),
  )

  return {
    pages: Array.from(pages.values())
      .sort((a, b) => b.observed - a.observed)
      .map(({ observed: _, ...page }) => page),
  }
}

export function findPresentPage(registry: PresentPageRegistry, pageID: string) {
  return registry.pages.find((page) => page.id === pageID)
}

export function matchPresentPageHref(registry: PresentPageRegistry, href: string) {
  const target = href.split("#", 1)[0]
  return registry.pages.find((page) => page.hrefs.some((candidate) => candidate.split("#", 1)[0] === target))
}

function isGenericMarkdownTitle(page: PresentPageRegistryPage) {
  if (page.title === page.id) return true
  return /^revision\s+[1-9][0-9]*$/i.test(page.title)
}

function reachesSession(
  sessionID: string,
  target: string,
  sessions: ReadonlyMap<string, { id: string; parentID?: string }>,
  seen = new Set<string>(),
): boolean {
  if (sessionID === target) return true
  if (seen.has(sessionID)) return false
  seen.add(sessionID)
  const parentID = sessions.get(sessionID)?.parentID
  if (!parentID) return false
  return reachesSession(parentID, target, sessions, seen)
}
