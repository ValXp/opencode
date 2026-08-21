import { createMemo, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import {
  matchPresentPageHref,
  parsePresentPageMetadata,
  useData,
  type OpenPresentPageFn,
  type OpenPresentPageRequest,
  type PresentPageRegistry,
} from "../context"
import { BasicTool, GenericTool } from "./basic-tool"
import type { ToolProps } from "./message-part"

type PresentPageClick = Pick<MouseEvent, "altKey" | "button" | "ctrlKey" | "metaKey" | "shiftKey" | "preventDefault">

export function isUnmodifiedPrimaryClick(event: PresentPageClick) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
}

export function getPresentPageOpenRequest(
  registry: PresentPageRegistry,
  href: string,
): OpenPresentPageRequest | undefined {
  const page = matchPresentPageHref(registry, href)
  if (!page) return undefined
  return { pageID: page.id, href }
}

export function getPresentPageToolCard(status: string | undefined, metadata: unknown) {
  if (status !== "completed") return undefined
  const result = parsePresentPageMetadata(metadata)
  if (!result) return undefined
  return {
    pageID: result.page.id,
    title: result.page.title,
    revision: result.page.currentRevision,
    href: result.page.url,
  }
}

export function openPresentPageFromClick(
  event: PresentPageClick,
  request: OpenPresentPageRequest,
  open: OpenPresentPageFn | undefined,
) {
  if (!open || !isUnmodifiedPrimaryClick(event)) return false
  event.preventDefault()
  open(request)
  return true
}

export function handlePresentPageMarkdownClick(
  event: MouseEvent & { currentTarget: HTMLDivElement },
  registry: PresentPageRegistry,
  open: OpenPresentPageFn | undefined,
) {
  if (!open || !isUnmodifiedPrimaryClick(event)) return false
  const target = event.target
  if (!(target instanceof Element)) return false
  const anchor = target.closest<HTMLAnchorElement>("a[href]")
  if (!anchor || !event.currentTarget.contains(anchor)) return false
  const request = getPresentPageOpenRequest(registry, anchor.href)
  if (!request) return false
  return openPresentPageFromClick(event, request, open)
}

export function PresentPageTool(props: ToolProps) {
  const data = useData()
  const card = createMemo(() => getPresentPageToolCard(props.status, props.metadata))

  return (
    <Show
      when={card()}
      fallback={<GenericTool tool={props.tool} status={props.status} input={props.input} />}
    >
      {(value) => (
        <BasicTool
          icon="window-cursor"
          status={props.status}
          hideDetails
          clickable
          triggerHref={value().href}
          triggerTarget="_blank"
          triggerRel="noopener noreferrer"
          onTriggerClick={(event) =>
            openPresentPageFromClick(
              event,
              { pageID: value().pageID, href: value().href },
              data.openPresentPage,
            )
          }
          trigger={
            <div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">
                  <bdi dir="auto">{value().title}</bdi>
                </span>
                <span data-slot="basic-tool-tool-subtitle">
                  <bdi dir="ltr">#{value().revision}</bdi>
                </span>
              </div>
              <div data-component="tool-action">
                <Icon name="square-arrow-top-right" size="small" />
              </div>
            </div>
          }
        />
      )}
    </Show>
  )
}
