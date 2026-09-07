import { Schema } from "effect"
import type { Tool } from "./tool"
import { Todo } from "../session/todo"

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(Todo.Info)).annotate({ description: "The updated todo list" }),
})

export type Metadata = {
  todos: Todo.Info[]
}

/** Historical payload shape retained for rendering persisted todowrite tool parts. */
export type TodoWriteTool = Tool.Info<typeof Parameters, Metadata>
