export type Suggestion = {
  /** Index into TIERS, lightest first. */
  tier: number
  /** Short reasons, most telling first. */
  reasons: string[]
  /** The session's model and effort when it was worked out. */
  current: { model: string; effort: string | null }
  /** Whether the model and effort rows can be set from here. */
  canApply: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'model-hint': { suggestion: Shaped<Suggestion | null> }
  }
}
