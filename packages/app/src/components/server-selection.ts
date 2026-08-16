import { ServerConnection } from "@/context/server"

export function editedServerActivation(original: ServerConnection.Http, active: ServerConnection.Key) {
  return { activate: ServerConnection.key(original) === active }
}

export function selectServerConnection(input: {
  connection: ServerConnection.Any
  persist?: boolean
  add: (connection: ServerConnection.Http, options?: { activate?: boolean }) => ServerConnection.Http | undefined
  navigate: () => void
  setActive: (key: ServerConnection.Key) => void
}) {
  const connection =
    input.persist && input.connection.type === "http"
      ? input.add(input.connection, { activate: false })
      : input.connection
  if (!connection) return
  input.navigate()
  queueMicrotask(() => input.setActive(ServerConnection.key(connection)))
}
