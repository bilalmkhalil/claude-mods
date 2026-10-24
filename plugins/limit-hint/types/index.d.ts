export type LimitReading = { used: number; resetsAt: string | null; at: number }

declare module 'claude-code' {
  interface PluginState {
    'limit-hint': { reading: Shaped<LimitReading | null> }
  }
}
