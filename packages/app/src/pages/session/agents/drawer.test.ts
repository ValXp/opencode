import { expect, test } from "bun:test"
import { legacySessionHref } from "@/utils/session-route"
import { resolveLegacyAgentSessionHref } from "./drawer"

test("uses the cached target session directory for legacy navigation", async () => {
  const resolved: string[] = []
  const href = await resolveLegacyAgentSessionHref({
    sessionID: "ses_other",
    getSession: () => ({ directory: "/workspace/other" }),
    resolveSession: async (sessionID) => {
      resolved.push(sessionID)
      return { directory: "/workspace/wrong" }
    },
  })

  expect(href).toBe(legacySessionHref("/workspace/other", "ses_other"))
  expect(resolved).toEqual([])
})

test("waits for the target session location when prefetch has not completed", async () => {
  const response = Promise.withResolvers<{ directory: string }>()
  const resolved: string[] = []
  let settled = false
  const href = resolveLegacyAgentSessionHref({
    sessionID: "ses_other",
    getSession: () => undefined,
    resolveSession: (sessionID) => {
      resolved.push(sessionID)
      return response.promise
    },
  }).then((value) => {
    settled = true
    return value
  })

  await Promise.resolve()
  expect(settled).toBeFalse()
  expect(resolved).toEqual(["ses_other"])

  response.resolve({ directory: "/workspace/other" })
  expect(await href).toBe(legacySessionHref("/workspace/other", "ses_other"))
})
