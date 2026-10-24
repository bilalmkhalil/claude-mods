import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Suggestion } from '../types'

// The last suggestion. Writing it redraws the band, which reads it.
const suggestion = atom({ plugin: 'model-hint', key: 'suggestion' } as const, null, { shape: 'suggestion-4' })
// True while Haiku is working out a judgement: the avatar thinks.
const thinking = atom({ plugin: 'model-hint', key: 'thinking' } as const, false, { shape: 'thinking-1' })
// How the prompt is judged: by the word rules, or by asking Haiku. The band's switch flips it.
const mode = atom({ plugin: 'model-hint', key: 'mode' } as const, 'rules', { shape: 'mode-1' })
// True while the band asks to confirm a switch that re-reads a large conversation.
const confirming = atom({ plugin: 'model-hint', key: 'confirming' } as const, false, { shape: 'confirming-1' })
// Whether the band is folded to its title. Kept in the store too, so it stays as left next session.
const hidden = atom({ plugin: 'model-hint', key: 'hidden' } as const, false, { shape: 'hidden-1' })
// How many of the section's rows show: stepped one at a time toward all or none by Hide and Show,
// the nearest a band comes to a slide (its height moves in whole rows). ALL means every row.
const ALL = 99
const visible = atom({ plugin: 'model-hint', key: 'visible' } as const, ALL, { shape: 'visible-1' })
// The rows a fold steps through (the most the section draws), and the time per step.
const FOLD_ROWS = 5
const FOLD_STEP_MS = 40
let folding: { cancel: () => void } | undefined

// Folds or unfolds the section a row per step, then settles on none or ALL.
const fold = async ($: EngineInterface, to: boolean) => {
  folding?.cancel()
  await update($, hidden, () => to)
  void $.store.set('hidden', to).catch(note)
  let at = Math.min(await read($, visible), FOLD_ROWS)
  folding = $.clock.every(FOLD_STEP_MS, () => {
    at += to ? -1 : 1
    const done = to ? at <= 0 : at >= FOLD_ROWS
    if (done) folding?.cancel()
    void update($, visible, () => (done ? (to ? 0 : ALL) : at)).catch(note)
  })
}

// A switch starts a new prompt cache, so the next turn re-reads the whole conversation uncached
// (a cache write, about 1.25x input, where a cached read is about 0.1x). Past WARN tokens Use asks
// first; past HOLD a switch is only suggested when it moves two tiers or more.
const REREAD_WARN = 20_000
const REREAD_HOLD = 60_000
const kTokens = (n: number) => `${Math.round(n / 1000)}k`

// Where a model family sits among the tiers: the lightest tier it serves, and its heaviest.
const SPAN: Record<string, [number, number]> = { haiku: [0, 0], sonnet: [1, 1], opus: [2, 4] }
const familyOf = (model: string) => Object.keys(SPAN).find(f => model.toLowerCase().includes(f))

// Lightest first. `family` is matched against the model row's options and the session's model id.
const TIERS = [
  { family: 'haiku', name: 'Haiku 5.5', effort: 'low', why: 'quick task' },
  { family: 'sonnet', name: 'Sonnet 5.5', effort: 'medium', why: 'everyday coding' },
  { family: 'opus', name: 'Opus 5.5', effort: 'medium', why: 'multi-file work' },
  { family: 'opus', name: 'Opus 5.5', effort: 'high', why: 'hard problem' },
  { family: 'opus', name: 'Opus 5.5', effort: 'xhigh', why: 'deep reasoning' },
] as const

// The width of the band's label column, in cells; limit-hint's band uses the same so the two line up.
const LABEL_WIDTH = 13

// The model row's slots, in cells, each as wide as its longest content: the row reads the same,
// nothing sliding along, whichever model, effort or state it shows, and with or without Use.
const NAME_WIDTH = 11
const EFFORT_WIDTH = 10
const STATUS_WIDTH = 21
const USE_WIDTH = 20

// The bands keep to three colors: the theme's grays, the accent orange, and amber for a warning.
const ACCENT = '#d97757'

// The model's mark: a small spark in the accent.
const spark = () => {
  const c = ACCENT
  const rays = [0, 45, 90, 135]
    .map(a => `<rect x="6.1" y="0.5" width="1.8" height="13" rx="0.9" fill="${c}" transform="rotate(${a} 7 7)"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${rays}</svg>`
}

// The actions' marks, the size of the model's and the effort's. Swap: two arrows passing, in
// gray, for how the prompt is judged. Go: an arrow in the accent, for Use.
const SWAP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#c8c8c8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M1.5 4.5h10M9 2l2.5 2.5L9 7"/><path d="M12.5 9.5h-10M5 7L2.5 9.5 5 12"/></svg>'
const GO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#d97757" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2 7h10M8 3l4 4-4 4"/></svg>'

// Claude, in pixels, behind the hints at the right: drawn to the welcome screen's figure (a body
// 12 by 6, arms 2 wide at its middle, eyes 1 by 2, four legs), its pose and what floats around it
// saying how the band reads.
export type Mood = 'sleepy' | 'thinking' | 'happy' | 'pointing' | 'puffed' | 'curious'
const U = 4 // one pixel of the drawing, in CSS pixels
const AVATAR_W = 24
const AVATAR_H = 13
// Cells the rows beside Claude keep clear at their right: its width and a little air.
const AVATAR_CLEAR = 14
const INK = '#1f1f1f'
const DUST = '#8a8a8a'
const px = (x: number, y: number, w: number, h: number, fill: string) =>
  `<rect x="${x * U}" y="${y * U}" width="${w * U}" height="${h * U}" fill="${fill}"/>`
// A loop of `values` for one attribute, `dur` long, starting `begin` in.
const loop = (attr: string, values: string, dur: number, begin = 0) =>
  `<animate attributeName="${attr}" values="${values}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`
const drift = (values: string, dur: number, begin = 0) =>
  `<animateTransform attributeName="transform" type="translate" values="${values}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`
// A shape of pixels, floating up and fading, again and again.
const floatUp = (cells: [number, number][], x: number, y: number, fill: string, dur: number, begin = 0) =>
  `<g>${cells.map(([cx, cy]) => px(x + cx, y + cy, 1, 1, fill)).join('')}` +
  drift(`0 ${2 * U};0 0;0 ${-2 * U}`, dur, begin) +
  loop('opacity', '0;1;0', dur, begin) +
  '</g>'
// Dust twinkling around it, as on the welcome screen.
const SPECKS: [number, number, number][] = [
  [1, 3, 0], [2, 9, 1.1], [3, 1, 2.3], [21, 2, 0.6], [22, 8, 1.7], [23, 5, 2.9], [0, 11, 0.4], [19, 0, 2.0], [12, 0, 1.4], [6, 1, 3.1],
]
const avatar = (mood: Mood) => {
  const ox = 4
  const oy = 5
  const specks = SPECKS.map(
    ([x, y, b]) =>
      `<rect x="${x * U + 1}" y="${y * U + 1}" width="${U / 2}" height="${U / 2}" fill="${DUST}" opacity="0.2">${loop('opacity', '0.15;0.7;0.15', 3.2, b)}</rect>`,
  ).join('')
  // Eyes: where they look, and whether they're shut; open ones blink.
  const look = mood === 'pointing' ? 1 : 0
  const up = mood === 'thinking' ? -1 : 0
  const blink = mood === 'curious' ? 2.2 : 4.5
  const eye = (x: number) => {
    if (mood === 'sleepy') return px(ox + x, oy + 3, 1, 1, INK)
    const top = (oy + 2 + up) * U
    return (
      `<rect x="${(ox + x + look) * U}" y="${top}" width="${U}" height="${2 * U}" fill="${INK}">` +
      loop('height', `${2 * U};${2 * U};${U / 2};${2 * U}`, blink) +
      loop('y', `${top};${top};${top + U + U / 2};${top}`, blink) +
      '</rect>'
    )
  }
  const body =
    px(ox + 2, oy, 12, 6, ACCENT) +
    px(ox, oy + 2, 2, 2, ACCENT) +
    px(ox + 14, oy + 2, 2, 2, ACCENT) +
    eye(4) +
    eye(11) +
    [3, 5, 10, 12].map(x => px(ox + x, oy + 6, 1, 2, ACCENT)).join('')
  // How it moves: a slow breath asleep, a hop when pleased, a lean toward Use when it has a pick.
  const sway =
    mood === 'happy'
      ? drift(`0 0;0 ${-U};0 0`, 0.9)
      : mood === 'pointing'
        ? drift(`0 0;${U / 2} 0;0 0`, 1.4)
        : mood === 'sleepy'
          ? drift(`0 0;0 ${U / 4};0 0`, 3.6)
          : drift(`0 0;0 ${-U / 4};0 0`, 2.4)
  const extra =
    mood === 'sleepy'
      ? floatUp([[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]], 19, 1, DUST, 3.2)
      : mood === 'thinking'
        ? [9, 11, 13]
            .map((x, i) => `<rect x="${x * U}" y="${2 * U}" width="${U}" height="${U}" fill="${DUST}">${loop('opacity', '0.2;1;0.2', 1.2, i * 0.3)}</rect>`)
            .join('')
        : mood === 'happy'
          ? floatUp([[0, 0], [2, 0], [0, 1], [1, 1], [2, 1], [1, 2]], 19, 1, ACCENT, 1.8)
          : mood === 'puffed'
            ? floatUp([[0, 0], [0, 1]], 21, 6, DUST, 1.6)
            : mood === 'curious'
              ? floatUp([[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [1, 4]], 19, 0, DUST, 2.6)
              : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_W * U}" height="${AVATAR_H * U}" viewBox="0 0 ${AVATAR_W * U} ${AVATAR_H * U}" shape-rendering="crispEdges">` +
    specks +
    `<g>${body}${sway}</g>` +
    extra +
    '</svg>'
  )
}
const MOOD_ALT: Record<Mood, string> = {
  sleepy: 'Claude dozing until there is a prompt',
  thinking: 'Claude thinking it over',
  happy: 'Claude pleased: the model in use fits',
  pointing: 'Claude pointing to a better fit',
  puffed: 'Claude a little puffed: limits or context are filling',
  curious: 'Claude asking before a switch',
}

// Effort as four rising bars, lit up to its level.
const LEVELS = ['low', 'medium', 'high', 'xhigh']
const gauge = (effort: string) => {
  const lit = LEVELS.indexOf(effort) + 1
  const bars = LEVELS.map((_, i) => {
    const h = 4 + i * 3
    return `<rect x="${i * 5}" y="${14 - h}" width="3" height="${h}" rx="1" fill="${i < lit ? '#c8c8c8' : '#88888873'}"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="14" viewBox="0 0 18 14">${bars}</svg>`
}

const LIGHT = /\b(rename|typo|format|lint|explain|what is|what's|list|show me|print|bump|comment|spelling|wording)\b/i
const HEAVY = [
  /\b(refactor|rewrite|restructure)\b/i,
  /\b(architect\w*|design|system)\b/i,
  /\b(debug|why does|why is|root cause|crash\w*|flaky|race condition|deadlock|leak)\b/i,
  /\b(migrat\w*|upgrade)\b/i,
  /\b(plan|strategy|trade-?offs?)\b/i,
  /\b(security|vulnerab\w*|auth\w*)\b/i,
  /\b(performance|optimi[sz]e|concurren\w*)\b/i,
]
const PATH = /(?:^|\s)[\w.-]*\/[\w./-]+|\b[\w-]+\.(?:tsx?|jsx?|py|go|rs|java|kt|rb|md|json|ya?ml|css|html|sql)\b/g
const CODE = /```|^\s+at .+\(.+:\d+:\d+\)|Traceback \(most recent call last\)|^\s*(?:Error|TypeError|Exception)\b/m

// Scores a prompt from 0 (Haiku, low) to 4 (Opus, xhigh), with the reasons for it.
const score = (text: string) => {
  const reasons: string[] = []
  let s = 1
  const heavy = HEAVY.filter(re => re.test(text)).length
  if (heavy) {
    s += Math.min(2, heavy)
  } else if (LIGHT.test(text) || text.length < 40) {
    s -= 1
  }
  if (text.length > 400) s += 1
  if (text.length > 1500) s += 1
  const paths = new Set(text.match(PATH) ?? []).size
  if (paths >= 3) {
    s += 1
    reasons.push(`${paths} files named`)
  }
  if (CODE.test(text)) {
    s += 1
    reasons.push('code or a trace pasted')
  }
  return { tier: Math.max(0, Math.min(TIERS.length - 1, s)), reasons }
}

// Haiku's judgement of a prompt, as a tier and a few words why; undefined when it gave none.
const HAIKU_SYSTEM = [
  'You pick the Claude model and reasoning effort a coding request needs. Reply with JSON only:',
  '{"tier": <0-4>, "why": "<at most 5 words>"}',
  'Tiers: 0 = Haiku, low effort: trivial edits, lookups, one-line answers.',
  '1 = Sonnet, medium: everyday coding, a focused change, a clear question.',
  '2 = Opus, medium: multi-file changes, unfamiliar code, careful debugging.',
  '3 = Opus, high: hard bugs, design and architecture, plans with trade-offs.',
  '4 = Opus, xhigh: the hardest problems: deep concurrency, security, large redesigns.',
  'Judge what the request asks, not its length or the words it uses.',
].join('\n')

// Haiku answers once per prompt text; a pause on the same text reuses it.
const judged = new Map<string, { tier: number; why: string }>()
let asking: AbortController | undefined

const askHaiku = async ($: EngineInterface, text: string) => {
  const known = judged.get(text)
  if (known) return known
  asking?.abort()
  const stop = new AbortController()
  asking = stop
  await update($, thinking, () => true)
  const r = await $.model
    .complete(
      { model: 'haiku', system: HAIKU_SYSTEM, prompt: text.slice(0, 6000), maxTokens: 60, timeoutMs: 10_000 },
      { signal: stop.signal },
    )
    .finally(() => {
      if (asking === stop) void update($, thinking, () => false)
    })
  if (!r.isAnswered) {
    if (r.reason !== 'aborted') lastError = `haiku: ${r.reason}`
    return undefined
  }
  const m = r.text.match(/\{[^}]*\}/)
  const parsed = m ? (JSON.parse(m[0]) as { tier?: unknown; why?: unknown }) : {}
  if (typeof parsed.tier !== 'number' || parsed.tier < 0 || parsed.tier >= TIERS.length) {
    lastError = `haiku: no tier in ${JSON.stringify(r.text.slice(0, 80))}`
    return undefined
  }
  const out = { tier: Math.round(parsed.tier), why: typeof parsed.why === 'string' ? parsed.why.slice(0, 60) : TIERS[Math.round(parsed.tier)]!.why }
  if (judged.size > 200) judged.clear()
  judged.set(text, out)
  return out
}

const find = (rows: readonly ConfigRow[], word: RegExp) =>
  rows.find(r => word.test(r.key)) ?? rows.find(r => word.test(r.label))

const settable = (row: ConfigRow | undefined) => !!row && !row.isLocked && (row.kind === 'choice' || row.kind === 'text')

// What the model row takes for a tier: the option naming its family, else the family as an alias.
const modelValue = (row: ConfigRow, family: string) =>
  row.options?.find(o => o.toLowerCase().includes(family)) ?? (row.kind === 'text' ? family : undefined)

const effortValue = (row: ConfigRow, effort: string) =>
  row.options ? row.options.find(o => o.toLowerCase() === effort) : row.kind === 'text' ? effort : undefined

// The draft as last seen, and the last prompt sent: the band falls back to it when the box is empty.
let draft = ''
let lastSent = ''
let pending: { cancel: () => void } | undefined
// What last went wrong working out a suggestion, for /model-hint.
let lastError = ''

const note = (err: unknown) => {
  lastError = err instanceof Error ? err.message : String(err)
}

const recompute = async ($: EngineInterface) => {
  const text = draft.trim() || lastSent.trim()
  if (!text) {
    await update($, suggestion, () => null)
    return
  }
  // Each read stands alone: a host without one (the desktop may keep /config to itself) still
  // gets a suggestion, just without what that read adds.
  const skip = (what: string) => (err: unknown) => {
    lastError = `${what}: ${err instanceof Error ? err.message : String(err)}`
    return undefined
  }
  const [usage, model, rows] = await Promise.all([
    $.session.usage().catch(skip('usage')),
    $.session.model().catch(skip('model')),
    $.config.list().catch(skip('config')),
  ])
  const rateLimits = usage?.rateLimits ?? []
  const context = usage?.context ?? { window: 0 }
  // Haiku's tier when asked for and it answers, else the word rules'.
  const by = await read($, mode)
  const judgement = by === 'haiku' ? await askHaiku($, text).catch(err => (note(err), undefined)) : undefined
  // A newer pause took over while Haiku answered: let that one write.
  if (by === 'haiku' && text !== (draft.trim() || lastSent.trim())) return
  const ruled = score(text)
  let tier = judgement ? judgement.tier : ruled.tier
  const why = judgement ? [judgement.why] : [TIERS[tier]!.why, ...ruled.reasons]
  // What bent the suggestion or should give pause: drawn on a line of its own above it.
  const warnings: string[] = []
  const source: Suggestion['source'] = judgement ? 'haiku' : by === 'haiku' ? 'rules-fallback' : 'rules'

  // Room left in the limits: step down as they fill, and keep xhigh for when there's plenty.
  const used = Math.max(0, ...rateLimits.filter(r => r.kind === 'five_hour' || r.kind === 'seven_day').map(r => r.percentUsed))
  if (used >= 90) tier = Math.max(0, tier - 2)
  else if (used >= 75) tier = Math.max(0, tier - 1)
  else if (used >= 50) tier = Math.min(tier, 3)
  if (used >= 75) warnings.push(`You've used ${used}% of your limit, so this leans lighter.`)

  // A full context makes every turn costly: think less, and say compacting helps.
  const fill = context.percent ?? 0
  if (fill >= 70) {
    if (tier >= 3) tier -= 1
    warnings.push(`The conversation fills ${fill}% of the context; /compact frees room.`)
  }

  // Deep into a conversation a switch costs a full re-read: stay on the current model unless the
  // suggestion is two tiers or more from what it serves.
  const tokens = context.tokens ?? 0
  const family = familyOf(model ?? '')
  if (family && tokens >= REREAD_HOLD && TIERS[tier]!.family !== family) {
    const [lo, hi] = SPAN[family]!
    const nearest = Math.max(lo, Math.min(hi, tier))
    if (Math.abs(nearest - tier) < 2) {
      tier = nearest
      const name = TIERS.find(x => x.family === family)!.name
      warnings.push(`Staying on ${name} keeps this chat's ${kTokens(tokens)} tokens cached, cheaper than a switch here.`)
    }
  }

  const modelRow = find(rows ?? [], /^model$|\bmodel\b/i)
  const effortRow = find(rows ?? [], /effort/i)
  const effort = effortRow && typeof effortRow.value === 'string' ? effortRow.value : null
  // The model alone can be switched where the host has no effort setting.
  const canApply = settable(modelRow)
  const prev = await read($, suggestion)
  const next: Suggestion = { tier, reasons: why, warnings, current: { model: model ?? '', effort }, canApply, source, contextTokens: tokens }
  if (prev?.tier !== tier) await update($, confirming, () => false)
  await update($, suggestion, () => next)
}

// Typing comes in bursts: work it out once the person pauses, a longer pause before asking Haiku.
const schedule = async ($: EngineInterface) => {
  pending?.cancel()
  const wait = (await read($, mode)) === 'haiku' ? 1200 : 300
  pending = $.clock.after(wait, () => void recompute($).catch(note))
}

const apply = async ($: EngineInterface, tier: number) => {
  const t = TIERS[tier]!
  const rows = await $.config.list()
  const modelRow = find(rows, /^model$|\bmodel\b/i)
  const effortRow = find(rows, /effort/i)
  const model = modelRow && modelValue(modelRow, t.family)
  const effort = effortRow && effortValue(effortRow, t.effort)
  await update($, confirming, () => false)
  if (!modelRow || !model) {
    $.ui.toast(`Couldn't switch to ${t.name} from here`)
    return
  }
  const a = await $.config.set({ key: modelRow.key, value: model })
  const b = a.deny || !effortRow || !effort ? a : await $.config.set({ key: effortRow.key, value: effort })
  if (b.deny) $.ui.toast(`Couldn't switch: ${b.deny}`)
  else if (!effortRow || !effort) $.ui.toast(`Switched to ${t.name}. Set effort to ${t.effort} in the model picker.`)
  await recompute($)
}

// Use: straight to the switch in a short conversation, else ask first with what it re-reads.
const use = async ($: EngineInterface, s: Suggestion) => {
  if (s.contextTokens >= REREAD_WARN) await update($, confirming, () => true)
  else await apply($, s.tier)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void $.store
      .get('hidden')
      .then(async v => {
        await update($, hidden, () => v === true)
        await update($, visible, () => (v === true ? 0 : ALL))
      })
      .catch(note)
    // A reload forgets the last prompt: take it back from the transcript.
    void $.session
      .messages()
      .then(ms => {
        lastSent = ms.findLast(m => m.role === 'user' && !m.toolResults?.length && m.text.trim())?.text ?? ''
        return recompute($)
      })
      .catch(note)
    // The limits and the context move between turns too.
    $.clock.every(60_000, () => void recompute($).catch(note))
    await $.command.register({ name: 'model-hint', description: 'Show what model-hint sees: the model and effort settings it would switch' })
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    draft = box.text
    void schedule($).catch(note)
    return box
  })

  // Changes no keystroke made: a clear, a recalled entry, a plugin's fill.
  on('prompt.change', async ($, e, next) => {
    draft = e.text
    void schedule($).catch(note)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    lastSent = e.text
    draft = ''
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await recompute($).catch(note)
    return done
  })

  // Says what the mod sees, to check the Use button can work here.
  on('command.run', { command: 'model-hint' }, async $ => {
    const rows = await $.config.list().catch(err => {
      lastError = `config: ${err instanceof Error ? err.message : String(err)}`
      return []
    })
    const show = (r: ConfigRow | undefined) =>
      r ? `${r.key} (${r.kind}${r.isLocked ? ', locked' : ''}) = ${JSON.stringify(r.value)}${r.options ? ` · options ${r.options.join(', ')}` : ''}` : 'not found'
    return {
      text: [
        `session model: ${await $.session.model().catch(() => 'unknown')}`,
        `model row: ${show(find(rows, /^model$|\bmodel\b/i))}`,
        `effort row: ${show(find(rows, /effort/i))}`,
        `draft seen: ${JSON.stringify(draft.slice(0, 60))} · last sent: ${JSON.stringify(lastSent.slice(0, 60))}`,
        `judged by: ${await read($, mode)}`,
        `last error: ${lastError || 'none'}`,
      ].join('\n'),
    }
  })

  // Desktop app (Code tab): a band above the prompt. It draws itself on top of whatever the
  // plugins beneath it draw there (limit-hint's band), so the two stack in either load order.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.surface !== 'desktop' || e.props.hasSurvey) return below
    const s = await read($, suggestion)
    const isConfirming = await read($, confirming)
    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const stack = (row: RenderElement) =>
      below ? (
        <Box flexDirection="column" gap="sm">
          {row}
          {below}
        </Box>
      ) : (
        row
      )
    const by = await read($, mode)
    // Flips how the prompt is judged; the band says which judged this one.
    // An action: its mark, then its words, all one control. A Button holds text alone, so its
    // label starts with room for the mark, and the mark is laid over that room; a placed Box
    // passes the pointer through, so a press on the mark lands on the Button beneath.
    // An action: its mark, then its words, with the model row's gap between. The words are the
    // control: a Button holds text alone, draws it in its own weight, and a placed Box laid over
    // it would take the press itself, so the mark sits beside the Button, not on it.
    const action = (icon: string, alt: string, key: string, label: string, onPress: () => void) => (
      <Box flexShrink={0} flexDirection="row" alignItems="center" gap="sm">
        <Svg source={icon} width={14} height={14} alt={alt} />
        <Button key={key} plain label={label} onPress={onPress} />
      </Box>
    )
    const toggle = action(
      SWAP,
      'Change how the prompt is judged',
      'mode',
      by === 'haiku' ? 'Haiku' : 'Rules',
      () =>
        void update($, mode, m => (m === 'haiku' ? 'rules' : 'haiku'))
          .then(() => recompute($))
          .catch(note),
    )
    // The section: its title, then its rows. How the prompt is judged has a row of its own.
    const isThinking = await read($, thinking)
    const isHidden = await read($, hidden)
    const rowsShown = await read($, visible)
    const isFolded = rowsShown === 0
    // What the title row says while folded: the pick in a line. Set below once there is one.
    let summary = 'type a prompt for a suggestion'
    // The title row: the name with Hide or Show right beside it, then the summary while folded.
    const title = () => (
      <Box flexDirection="row" alignItems="center" width="100%" gap="lg">
        <Box flexShrink={0} flexDirection="row" alignItems="center" gap="md">
          <Text bold>Model hints</Text>
          <Button key="fold" plain dimColor label={isHidden ? 'Show' : 'Hide'} onPress={() => void fold($, !isHidden).catch(note)} />
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {isFolded ? <Text dimColor>{summary}</Text> : null}
        </Box>
      </Box>
    )
    // The section: its title and rows, Claude at the top right, its mood read off the band.
    // Placed, Claude takes no room, so no row is pushed or cut by it. The desktop paints a placed
    // Box over everything in the flow, whatever the order, so text can't pass over Claude: the
    // rows beside it (the title and the next two) stop short of it and wrap instead. Folded, the
    // section is its title alone; mid-fold, its first rows. Claude comes on once the section is
    // tall enough to hold it, so the band never clips it.
    const section = (mood: Mood, ...rows: (RenderElement | null)[]) => {
      if (isFolded) {
        return (
          <Box flexDirection="column" width="100%" paddingX="sm">
            {title()}
          </Box>
        )
      }
      const all = rows.filter((r): r is RenderElement => r !== null)
      const shown = all.slice(0, rowsShown)
      return (
        <Box position="relative" flexDirection="column" width="100%" paddingX="sm">
          {shown.length >= Math.min(3, all.length) ? (
            <Box position="absolute" right={1} top={0}>
              <Svg source={avatar(mood)} width={AVATAR_W * U} height={AVATAR_H * U} alt={MOOD_ALT[mood]} />
            </Box>
          ) : null}
          <Box flexDirection="column" width="100%" gap="sm">
            <Box flexDirection="column" paddingRight={AVATAR_CLEAR} gap="sm">
              {title()}
              {shown.slice(0, 2)}
            </Box>
            {shown.slice(2)}
          </Box>
        </Box>
      )
    }
    const labelled = (label: string, body: RenderElement) => (
      <Box flexDirection="row" alignItems="center" width="100%" gap="lg">
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        {body}
      </Box>
    )
    const judgedRow = labelled('Judged by', toggle)
    if (!s) {
      return stack(section(isThinking ? 'thinking' : 'sleepy', labelled('Model', <Text dimColor>type a prompt for a suggestion</Text>), judgedRow))
    }
    const t = TIERS[s.tier]!
    // The effort is the app's to show where no setting reports it: then the model alone decides.
    const fits =
      s.current.model.toLowerCase().includes(t.family) &&
      (s.current.effort === null || s.current.effort.toLowerCase() === t.effort)
    const switchable = s.canApply && !fits
    const reread = switchable && s.contextTokens >= REREAD_WARN
    const warnings = [
      ...s.warnings,
      ...(reread ? [`A switch starts a fresh cache, so your next message re-reads ${kTokens(s.contextTokens)} tokens once.`] : []),
    ]
    const reasons = [...s.reasons, ...(s.source === 'rules-fallback' ? ["Haiku didn't answer, judged by rules"] : [])]
    // A line beside the label column: the label (or nothing) and text that wraps rather than cuts.
    const line = (label: RenderElement | null, body: RenderElement) => (
      <Box flexDirection="row" alignItems="flex-start" width="100%" gap="lg">
        <Box width={LABEL_WIDTH} flexShrink={0}>
          {label}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {body}
        </Box>
      </Box>
    )
    // Context, not alarm: the notes read like the other rows, a dim label and plain words.
    const alertLabel = (text: string) => <Text dimColor>{text}</Text>
    const warningLine = warnings.length
      ? line(alertLabel('Good to know'), <Text>{warnings.join('  ')}</Text>)
      : null
    // What the session runs now, said in words beside the suggestion: in use, or what it is instead.
    const nowOn = TIERS.find(x => s.current.model.toLowerCase().includes(x.family))?.name
    const status = fits ? (
      <Text>in use</Text>
    ) : nowOn ? (
      <Text dimColor>{`you're on ${nowOn}`}</Text>
    ) : null
    // The reason leads, named for who gave it: Haiku's read of the prompt, or the word rules'.
    const reasonLine = line(
      <Text dimColor>{s.source === 'haiku' ? "Haiku's take" : 'Reason'}</Text>,
      <Text>{reasons.join('   ·   ')}</Text>,
    )
    // Top: the warnings when any, then why. Then one row read left to right: the label, the
    // suggested model and its effort, whether it's in use, and the actions at the end.
    summary = `${t.name} · ${t.effort} · ${fits ? 'in use' : nowOn ? `you're on ${nowOn}` : 'suggested'}`
    const mood: Mood = isThinking ? 'thinking' : !fits ? 'pointing' : warnings.length ? 'puffed' : 'happy'
    const view = section(
      mood,
      warningLine,
      reasonLine,
      judgedRow,
      <Box flexDirection="row" alignItems="center" width="100%" gap="lg">
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text dimColor>Model</Text>
        </Box>
        <Box width={NAME_WIDTH} flexShrink={0} flexDirection="row" alignItems="center" gap="sm">
          <Svg source={spark()} width={14} height={14} alt={t.name} />
          <Text bold>{t.name}</Text>
        </Box>
        <Box width={EFFORT_WIDTH} flexShrink={0} flexDirection="row" alignItems="center" gap="sm">
          <Svg source={gauge(t.effort)} width={18} height={14} alt={`${t.effort} effort`} />
          <Text dimColor>{t.effort}</Text>
        </Box>
        <Box width={STATUS_WIDTH} flexShrink={0}>
          {status}
        </Box>
        <Box flexGrow={1} />
        {/* Use is drawn plain, as the switch is, so the row keeps one height; its slot stays when empty. */}
        <Box width={USE_WIDTH} flexShrink={0} flexDirection="row" justifyContent="flex-end">
          {switchable
            ? action(GO, `Switch to ${t.name}`, 'use', `Use ${t.name}`, () => void use($, s).catch(note))
            : null}
        </Box>
      </Box>,
    )
    // Asked before a switch that re-reads a large conversation: what it costs, then go or stay.
    const confirm = section(
      'curious',
      line(
        alertLabel('Switching'),
        <Text>
          {`Moving to ${t.name} re-reads this conversation's ${kTokens(s.contextTokens)} tokens uncached on the next turn, about 12× what those tokens cost on a cached turn. Later turns are cached again.`}
        </Text>,
      ),
      line(
        null,
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Button key="switch" variant="primary" label={`Switch to ${t.name}`} onPress={() => void apply($, s.tier).catch(note)} />
          <Button key="keep" label="Keep current" onPress={() => void update($, confirming, () => false).catch(note)} />
        </Box>,
      ),
    )
    if (isConfirming && switchable) return stack(confirm)
    return stack(view)
  })
}
