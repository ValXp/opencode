import { Schema } from "effect"
import type { Tool } from "./tool"
import { Question } from "../question"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

export type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

/** Historical payload shape retained for rendering persisted question tool parts. */
export type QuestionTool = Tool.Info<typeof Parameters, Metadata>
