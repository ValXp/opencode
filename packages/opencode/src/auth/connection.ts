const generations = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
let next = 0

export function current(key: string) {
  const value = generations.get(key)
  if (value) return value.toString()
  const generation = ++next
  generations.set(key, generation)
  return generation.toString()
}

export function advance(key: string) {
  generations.set(key, ++next)
  for (const listener of listeners.get(key) ?? []) listener()
}

export function listen(key: string, listener: () => void) {
  const current = listeners.get(key) ?? new Set()
  current.add(listener)
  listeners.set(key, current)
  return () => current.delete(listener)
}

export * as AuthConnection from "./connection"
