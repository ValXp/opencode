import { setMotionDisabled } from "@opencode-ai/ui/motion-spring"

export function powerSavingsPreference(general: { powerSavings?: boolean } | undefined) {
  return general?.powerSavings ?? false
}

export function setPowerSavingsMode(root: HTMLElement, enabled: boolean) {
  root.toggleAttribute("data-power-savings", enabled)
  setMotionDisabled(enabled)
}

export function powerSavingsScrollBehavior(enabled: boolean): ScrollBehavior {
  return enabled ? "auto" : "smooth"
}

export function powerSavingsMotionDuration(enabled: boolean, seconds: number) {
  return enabled ? 0 : seconds
}
