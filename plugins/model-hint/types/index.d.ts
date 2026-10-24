export type Suggestion = {
  /** Index into TIERS, lightest first. */
  tier: number
  /** Short reasons, most telling first. */
  reasons: string[]
  /** What bent the suggestion or should give pause: the limits, the context, a costly switch. */
  warnings: string[]
  /** The session's model and effort when it was worked out. */
  current: { model: string; effort: string | null }
  /** Whether the model and effort rows can be set from here. */
  canApply: boolean
  /** What judged the prompt: the word rules, Haiku, or the rules after Haiku gave no answer. */
  source: 'rules' | 'haiku' | 'rules-fallback'
  /** The conversation's size in tokens: what a switch makes the next turn re-read. */
  contextTokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-hint': { suggestion: Shaped<Suggestion | null>; mode: Shaped<'rules' | 'haiku'>; confirming: Shaped<boolean>; thinking: Shaped<boolean>; hidden: Shaped<boolean>; visible: Shaped<number> }
  }
}
