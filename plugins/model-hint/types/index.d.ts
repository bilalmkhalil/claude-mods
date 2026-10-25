export type Suggestion = {
  /** True while the prompt box is empty: nothing judged, the band shows the model in use. */
  idle: boolean
  /** Index into TIERS, lightest first: what the band puts in the Model row. */
  tier: number
  /**
   * What the band advises against the model in use: it already fits; switch to a cheaper one that
   * repays the move soon; stay, as a cheaper one wouldn't repay it in time; or move up, as the
   * work needs a bigger one.
   */
  advice: 'fits' | 'switch' | 'stay' | 'upgrade'
  /** On `stay`, the tier the prompt was judged to need, which the band advises against moving to. */
  alt: number | null
  /** Short reasons, most telling first. */
  reasons: string[]
  /** What bent the suggestion or should give pause: the limits, the context. */
  warnings: string[]
  /** The model and effort the chat ran on when it was worked out. */
  current: { model: string; effort: string | null }
  /** What judged the prompt: the word rules, Haiku, or the rules after Haiku gave no answer. */
  source: 'rules' | 'haiku' | 'rules-fallback'
  /** The conversation's size in tokens: what a switch makes the next message re-read. */
  contextTokens: number
  /** How the account pays: a plan's usage limits, or credits at API prices. */
  billing: 'plan' | 'credits'
  /**
   * The judged model priced against the one in use on this chat's own messages, in API dollars
   * (a plan reads them as shares): one message on each; the saving (negative when it costs more);
   * what switching costs once and how many tokens it re-reads (fewer when that model's cache is
   * still warm, `warmMinutes` after it last answered); the messages the saving takes to repay it;
   * and whether the messages were guessed, none being measured yet. Null when nothing differs.
   */
  compare: {
    here: number
    there: number
    saving: number
    switchCost: number
    breakEven: number | null
    lacks: number
    warmMinutes: number | null
    isEstimate: boolean
  } | null
}

/** One message's tokens: uncached input, output, and what the prompt cache read and wrote. */
export type Mix = { input: number; output: number; cacheRead: number; cacheWrite: number }

declare module 'claude-code' {
  interface PluginState {
    'model-hint': {
      suggestion: Shaped<Suggestion | null>
      mode: Shaped<'rules' | 'haiku'>
      thinking: Shaped<boolean>
      hidden: Shaped<boolean>
      visible: Shaped<number>
      running: Shaped<{ model: string; effort: string | null } | null>
      perMessage: Shaped<Mix | null>
    }
  }
}
