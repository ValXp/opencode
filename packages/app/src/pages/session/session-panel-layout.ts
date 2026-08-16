export function sessionPanelLayout(input: { workspace: boolean; terminal: boolean }) {
  return {
    visible: input.workspace || input.terminal,
    stacked: input.workspace && input.terminal,
  }
}
