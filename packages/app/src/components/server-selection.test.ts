import { expect, test } from "bun:test"
import { editedServerActivation, selectServerConnection } from "./server-selection"
import { ServerConnection } from "@/context/server"

test("persists a server before navigating and activates it afterward", async () => {
  const events: string[] = []
  const connection = { type: "http", http: { url: "https://server.example.test" } } as const

  selectServerConnection({
    connection,
    persist: true,
    add(input, options) {
      expect(input).toBe(connection)
      expect(options).toEqual({ activate: false })
      events.push("persist")
      return input
    },
    navigate() {
      events.push("navigate")
    },
    setActive(key) {
      events.push(`activate:${key}`)
    },
  })

  expect(events).toEqual(["persist", "navigate"])
  await Promise.resolve()
  expect(events).toEqual(["persist", "navigate", `activate:${ServerConnection.key(connection)}`])
})

test("editing an inactive server preserves the active server", () => {
  const active = ServerConnection.Key.make("https://active.example.test")
  const inactive = { type: "http", http: { url: "https://inactive.example.test" } } as const
  const current = { type: "http", http: { url: active } } as const

  expect(editedServerActivation(inactive, active)).toEqual({ activate: false })
  expect(editedServerActivation(current, active)).toEqual({ activate: true })
})
