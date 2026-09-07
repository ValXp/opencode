export * as ReservedTools from "./reserved"

const names = new Set(["question", "todowrite"])

export const has = (name: string) => names.has(name)
