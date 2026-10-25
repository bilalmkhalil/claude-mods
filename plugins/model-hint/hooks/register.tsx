import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Mix, Suggestion } from '../types'

// The last suggestion. Writing it redraws the band, which reads it.
const suggestion = atom({ plugin: 'model-hint', key: 'suggestion' } as const, null, { shape: 'suggestion-8' })
// True while Haiku is working out a judgement: the avatar thinks.
const thinking = atom({ plugin: 'model-hint', key: 'thinking' } as const, false, { shape: 'thinking-1' })
// How the prompt is judged: by the word rules, or by asking Haiku. The band's switch flips it.
const mode = atom({ plugin: 'model-hint', key: 'mode' } as const, 'rules', { shape: 'mode-1' })
// Whether the band is folded to its title. Kept in the store too, so it stays as left next session.
const hidden = atom({ plugin: 'model-hint', key: 'hidden' } as const, false, { shape: 'hidden-1' })
// The model and effort the chat runs on, kept live: the footer's picker as the engine reports a
// switch, the settings, and each request as it goes. The person picks; the band only advises.
const running = atom({ plugin: 'model-hint', key: 'running' } as const, null, { shape: 'running-1' })
// This chat's tokens per message, averaged over its last few: what a model's price is put to.
const perMessage = atom({ plugin: 'model-hint', key: 'perMessage' } as const, null, { shape: 'per-message-1' })
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

const kTokens = (n: number) => `${Math.round(n / 1000)}k`
const dollars = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : '<$0.01')

// API list prices, $ per million tokens: uncached input, output, cache read. Haiku's rise past 100k
// tokens of prompt; its cache read is taken as a tenth of input. A cache write costs 1.25x input
// for a 5-minute cache, 2x for an hour's. A plan's usage limit draws on the same mix, so the
// ratios hold for a plan as the dollars do for credits.
type Price = { input: number; output: number; read: number; write: number }
type Ttl = '5m' | '1h'
const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const BASE: Record<string, (prompt: number) => Omit<Price, 'write'>> = {
  opus: () => ({ input: 4, output: 20, read: 0.2 }),
  sonnet: () => ({ input: 2, output: 10, read: 0.2 }),
  haiku: prompt => (prompt > 100_000 ? { input: 0.5, output: 2.5, read: 0.05 } : { input: 0.1, output: 0.5, read: 0.01 }),
}
const priceOf = (family: string, prompt: number, ttl: Ttl): Price => {
  const b = BASE[family]!(prompt)
  return { ...b, write: b.input * (ttl === '1h' ? 2 : 1.25) }
}
const familyOf = (model: string) => Object.keys(BASE).find(f => model.toLowerCase().includes(f))

// What one message of this chat costs on a family, its tokens as measured.
const costOf = (family: string, mix: Mix, prompt: number, ttl: Ttl) => {
  const p = priceOf(family, prompt, ttl)
  return (mix.input * p.input + mix.output * p.output + mix.cacheRead * p.read + mix.cacheWrite * p.write) / 1e6
}

// What moving to a family costs once: its cache is the model's own, so the next message writes
// what that cache lacks where it would have read it. A model that answered within the cache's
// lifetime still holds the chat up to then, so going back to it re-reads only what came after.
const switchCostOf = (family: string, tokens: number, ttl: Ttl, at: number) => {
  const p = priceOf(family, tokens, ttl)
  const w = warm.get(family)
  const isWarm = !!w && at - w.at < TTL_MS[ttl]
  const lacks = isWarm ? Math.max(0, tokens - w.tokens) : tokens
  return { cost: (lacks * (p.write - p.read)) / 1e6, lacks, warmMinutes: isWarm ? Math.round((at - w.at) / 60_000) : null }
}

// A cheaper model is worth moving to only when the saving repays the switch within this many
// messages: past that, the next prompt may want another model and a switch again.
const HORIZON = 3

// Where a family sits among the tiers: the lightest tier it serves, and its heaviest.
const SPAN: Record<string, [number, number]> = { haiku: [0, 0], sonnet: [1, 1], opus: [2, 5] }

// A message's tokens before any is measured: the chat read twice from cache (a reply and a tool
// round), with a typical reply and what it adds.
const guessMix = (tokens: number): Mix => ({ input: 500, output: 1500, cacheRead: tokens * 2, cacheWrite: 2500 })

// Lightest first. `family` is matched against the model row's options and the session's model id.
const TIERS = [
  { family: 'haiku', id: 'claude-haiku-5-5', name: 'Haiku 5.5', effort: 'low', why: 'quick task' },
  { family: 'sonnet', id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', effort: 'medium', why: 'everyday coding' },
  { family: 'opus', id: 'claude-opus-5-5', name: 'Opus 5.5', effort: 'medium', why: 'multi-file work' },
  { family: 'opus', id: 'claude-opus-5-5', name: 'Opus 5.5', effort: 'high', why: 'hard problem' },
  { family: 'opus', id: 'claude-opus-5-5', name: 'Opus 5.5', effort: 'xhigh', why: 'deep reasoning' },
  { family: 'opus', id: 'claude-opus-5-5', name: 'Opus 5.5', effort: 'max', why: 'the hardest problem' },
] as const

// The width of the band's label column, in cells; limit-hint's band uses the same so the two line up.
const LABEL_WIDTH = 13

// The model row's slots, in cells, each as wide as its longest content: the row reads the same,
// nothing sliding along, whichever model, effort or state it shows, and with or without Use.
const NAME_WIDTH = 15
const EFFORT_WIDTH = 17

// The bands keep to the theme's grays and the accent orange; only the effort gauge adds amber and red.
const ACCENT = '#d97757'

// The model's mark: a small spark in the accent.
const spark = () => {
  const c = ACCENT
  const rays = [0, 45, 90, 135]
    .map(a => `<rect x="6.1" y="0.5" width="1.8" height="13" rx="0.9" fill="${c}" transform="rotate(${a} 7 7)"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${rays}</svg>`
}

// The judging switch's mark, the size of the model's and the effort's: two arrows passing, in gray.
const SWAP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#c8c8c8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M1.5 4.5h10M9 2l2.5 2.5L9 7"/><path d="M12.5 9.5h-10M5 7L2.5 9.5 5 12"/></svg>'
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

// Effort as six rising bars, one per option of the desktop's picker (the API's five levels, then
// Ultracode, which goes out as xhigh with the app's Ultracode mode on), lit up to its level in the
// level's color: gray for the everyday two, then the accent, amber, red and violet.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
const LEVEL_COLORS: Record<string, string> = {
  low: '#c8c8c8',
  medium: '#c8c8c8',
  high: ACCENT,
  xhigh: '#e5a50a',
  max: '#e5484d',
  ultracode: '#a78bfa',
}
// What the picker calls each level.
const LEVEL_NAMES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultracode: 'Ultracode' }
const levelName = (effort: string) => LEVEL_NAMES[effort] ?? effort
const GAUGE_W = 28
const gauge = (effort: string) => {
  const lit = LEVELS.indexOf(effort) + 1
  const on = LEVEL_COLORS[effort] ?? '#c8c8c8'
  const bars = LEVELS.map((_, i) => {
    const h = 4 + i * 2
    return `<rect x="${i * 5}" y="${14 - h}" width="3" height="${h}" rx="1" fill="${i < lit ? on : '#88888873'}"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GAUGE_W}" height="14" viewBox="0 0 ${GAUGE_W} 14">${bars}</svg>`
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
  '{"tier": <0-5>, "why": "<at most 5 words>"}',
  'Tiers: 0 = Haiku, low effort: trivial edits, lookups, one-line answers.',
  '1 = Sonnet, medium: everyday coding, a focused change, a clear question.',
  '2 = Opus, medium: multi-file changes, unfamiliar code, careful debugging.',
  '3 = Opus, high: hard bugs, design and architecture, plans with trade-offs.',
  '4 = Opus, xhigh: very hard problems: deep concurrency, security, large redesigns.',
  '5 = Opus, max: the hardest, where correctness matters more than cost.',
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

// The draft as last seen: what the band judges. Empty, the band shows the model in use.
let draft = ''
let pending: { cancel: () => void } | undefined
// What last went wrong working out a suggestion, for /model-hint.
let lastError = ''
// Each turn's tokens as its requests come back, and the last few finished turns'.
const turnMix = new Map<string, Mix>()
const RECENT = 5
let recent: Mix[] = []
// When each model family last answered, and the chat's size then: what its cache still holds.
const warm = new Map<string, { at: number; tokens: number }>()
// The cache's lifetime as the engine reported it at a switch; till then, an hour's for a plan's
// login (Claude Code's own) and five minutes' otherwise.
let reportedTtl: Ttl | null = null
// How the account pays: a plan's usage limits, or credits at API prices. Read at session start.
let identityKind: string | null = null
let planSeen = false
// The rows the app last gave the band, its width, and the rows the band worked out it needed.
let lastFit: { maxRows: number; bodyColumns: number; rows: number } | null = null
// Whether an effort change mid-chat re-read the cache, as measured: null till one is seen.
let effortBreaksCache: boolean | null = null
let lastStep: { model: string; effort: string | null } | null = null

const note = (err: unknown) => {
  lastError = err instanceof Error ? err.message : String(err)
}

const recompute = async ($: EngineInterface) => {
  const text = draft.trim()
  // Each read stands alone: a host without one (the desktop may keep /config to itself) still
  // gets a suggestion, just without what that read adds.
  const skip = (what: string) => (err: unknown) => {
    lastError = `${what}: ${err instanceof Error ? err.message : String(err)}`
    return undefined
  }
  const usage = await $.session.usage().catch(skip('usage'))
  const rateLimits = usage?.rateLimits ?? []
  const context = usage?.context ?? { window: 0 }
  const tokens = context.tokens ?? 0
  const current = (await read($, running)) ?? { model: (await $.session.model().catch(skip('model'))) ?? '', effort: null }
  const used = Math.max(0, ...rateLimits.filter(r => r.kind === 'five_hour' || r.kind === 'seven_day').map(r => r.percentUsed))
  // A plan's login pays in usage until its limit runs out; past it, and for credits, in dollars.
  // A plan shows in its 5-hour and weekly windows where the login doesn't say.
  const isPlan = identityKind === 'claude.ai' || (identityKind === null && rateLimits.some(r => r.kind === 'five_hour' || r.kind === 'seven_day'))
  planSeen = isPlan
  const billing: Suggestion['billing'] = isPlan && used < 100 ? 'plan' : 'credits'
  const ttl: Ttl = reportedTtl ?? (isPlan ? '1h' : '5m')
  // An empty prompt box: nothing to judge, so the band shows the model the chat runs now.
  if (!text) {
    const idle: Suggestion = {
      idle: true,
      tier: 0,
      advice: 'fits',
      alt: null,
      reasons: [],
      warnings: [],
      current,
      source: 'rules',
      contextTokens: tokens,
      billing,
      compare: null,
    }
    await update($, suggestion, () => idle)
    return
  }
  // Haiku's tier when asked for and it answers, else the word rules'.
  const by = await read($, mode)
  const judgement = by === 'haiku' ? await askHaiku($, text).catch(err => (note(err), undefined)) : undefined
  // A newer pause took over while Haiku answered: let that one write.
  if (by === 'haiku' && text !== draft.trim()) return
  const ruled = score(text)
  let tier = judgement ? judgement.tier : ruled.tier
  const why = judgement ? [judgement.why] : [TIERS[tier]!.why, ...ruled.reasons]
  // What bent the suggestion or should give pause: drawn on a line of its own above it.
  const warnings: string[] = []
  const source: Suggestion['source'] = judgement ? 'haiku' : by === 'haiku' ? 'rules-fallback' : 'rules'

  // Room left in the limits: step down as they fill; xhigh only under half used, max under a quarter.
  if (used >= 90) tier = Math.max(0, tier - 2)
  else if (used >= 75) tier = Math.max(0, tier - 1)
  else if (used >= 50) tier = Math.min(tier, 3)
  else if (used >= 25) tier = Math.min(tier, 4)
  if (used >= 75 && used < 100) warnings.push(`You've used ${used}% of your limit, so this leans lighter.`)
  if (isPlan && used >= 100) warnings.push("You're past your plan's limit, so further usage is billed at API prices.")

  // A full context makes every turn costly: think less, and say compacting helps.
  const fill = context.percent ?? 0
  if (fill >= 70) {
    if (tier >= 3) tier -= 1
    warnings.push(`The conversation fills ${fill}% of the context; /compact frees room.`)
  }

  // The pick priced against the model the chat runs on, on this chat's own messages: one message
  // on each, and what moving costs once. A cheaper model that wouldn't repay the move within
  // HORIZON messages isn't worth it: the band says stay, nearest in effort to what it judged.
  const measured = await read($, perMessage)
  const mix = measured ?? guessMix(tokens)
  const now = familyOf(current.model)
  const to = TIERS[tier]!.family
  let advice: Suggestion['advice'] = 'fits'
  let alt: number | null = null
  let compare: Suggestion['compare'] = null
  if (now && now !== to) {
    const here = costOf(now, mix, tokens, ttl)
    const there = costOf(to, mix, tokens, ttl)
    const sw = switchCostOf(to, tokens, ttl, await $.clock.now())
    const saving = here - there
    const breakEven = saving > 0 ? Math.max(1, Math.ceil(sw.cost / saving)) : null
    compare = { here, there, saving, switchCost: sw.cost, breakEven, lacks: sw.lacks, warmMinutes: sw.warmMinutes, isEstimate: !measured }
    if (saving <= 0) advice = 'upgrade'
    else if (breakEven !== null && breakEven <= HORIZON) advice = 'switch'
    else {
      advice = 'stay'
      alt = tier
      const [lo, hi] = SPAN[now]!
      tier = Math.max(lo, Math.min(hi, tier))
    }
  }
  const next: Suggestion = { idle: false, tier, advice, alt, reasons: why, warnings, current, source, contextTokens: tokens, billing, compare }
  await update($, suggestion, () => next)
}

// Typing comes in bursts: work it out once the person pauses, a longer pause before asking Haiku.
const schedule = async ($: EngineInterface) => {
  pending?.cancel()
  const wait = (await read($, mode)) === 'haiku' ? 1200 : 300
  pending = $.clock.after(wait, () => void recompute($).catch(note))
}

// The desktop app's own record of each chat: the picker's model and effort, and whether Ultracode
// is on, saved the moment the person picks. Found once by this session's id among the app's
// session files; then read again only when the file changes.
type Picked = { model: string | null; effort: string | null }
let desktopFile: string | null = null
let desktopLookedAt = 0
let desktopMtime = 0
let desktopPick: Picked | null = null
const DESKTOP_BASES = ['.config/Claude/claude-code-sessions', 'Library/Application Support/Claude/claude-code-sessions']
const findDesktopFile = async ($: EngineInterface) => {
  const home = $.plugin.root.split(/\/\.claude\/|\/\.config\/|\/Library\//)[0]
  const id = await $.session.id()
  for (const base of DESKTOP_BASES.map(b => `${home}/${b}`)) {
    if (!(await $.fs.exists(base).catch(() => false))) continue
    for (const a of await $.fs.list(base)) {
      if (a.kind !== 'dir') continue
      for (const b of await $.fs.list(`${base}/${a.name}`)) {
        if (b.kind !== 'dir') continue
        for (const f of await $.fs.list(`${base}/${a.name}/${b.name}`)) {
          if (f.kind !== 'file' || !f.name.startsWith('local_') || !f.name.endsWith('.json')) continue
          const path = `${base}/${a.name}/${b.name}/${f.name}`
          const text = await $.fs.read(path).catch(() => '')
          if (new RegExp(`"cliSessionId"\\s*:\\s*"${id}"`).test(text)) return path
        }
      }
    }
  }
  return null
}
const readDesktop = async ($: EngineInterface): Promise<Picked | null> => {
  const at = await $.clock.now()
  // A chat the app hasn't saved yet: look again every half minute.
  if (!desktopFile && at - desktopLookedAt > 30_000) {
    desktopLookedAt = at
    desktopFile = await findDesktopFile($).catch(() => null)
  }
  if (!desktopFile) return null
  const { mtimeMs } = await $.fs.stat(desktopFile)
  if (mtimeMs === desktopMtime) return desktopPick
  desktopMtime = mtimeMs
  const d = JSON.parse(await $.fs.read(desktopFile)) as { model?: unknown; effort?: unknown; sessionSettings?: { ultracode?: unknown } }
  desktopPick = {
    model: typeof d.model === 'string' ? d.model : null,
    effort: d.sessionSettings?.ultracode === true ? 'ultracode' : typeof d.effort === 'string' ? d.effort : null,
  }
  return desktopPick
}

// Reads the picker's model and effort (the desktop's record; elsewhere the session's model and the
// effort setting) and keeps `running` to them when either moved. Each read is local and the
// record is parsed only when it changed, so this runs every second.
let polled: { model: string; effort: string | null } | null = null
const follow = async ($: EngineInterface) => {
  const desk = await readDesktop($).catch(() => null)
  const model = desk?.model ?? (await $.session.model().catch(() => null))
  const setting = desk ? desk.effort : await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)
  const effort = typeof setting === 'string' && LEVELS.includes(setting) ? setting : null
  if (!model || (polled && polled.model === model && polled.effort === effort)) return
  const was = polled
  polled = { model, effort }
  // The first read seeds what nothing else has; after it, whichever of the two moved is the
  // person's change and wins over what the last request went out with.
  await update($, running, r =>
    !was
      ? (r ?? { model, effort })
      : { model: was.model !== model ? model : (r?.model ?? model), effort: was.effort !== effort ? effort : (r?.effort ?? effort) },
  )
  if (was) await recompute($)
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
    void $.session
      .identity()
      .then(id => {
        identityKind = 'kind' in id && typeof id.kind === 'string' ? id.kind : null
      })
      .catch(note)
      .then(() => follow($))
      .then(() => recompute($))
      .catch(note)
    // The picker can move at any time, the prompt box empty or not.
    $.clock.every(1_000, () => void follow($).catch(note))
    // The limits and the context move between turns too.
    $.clock.every(60_000, () => void recompute($).catch(note))
    await $.command.register({ name: 'model-hint', description: "Show what model-hint sees: the model in use and this chat's tokens per message" })
    return next(e)
  })

  // Each main-loop request, as it went: the model that answered and the tokens it took, added to
  // its turn; when its model last answered, for the cache it holds; and, where the effort moved on
  // the same model, whether that re-read the cache. A subagent's requests are its own.
  on('turn.step', async function* ($, e, next) {
    const done = yield* next(e)
    if (e.agentId !== undefined || !done.usage) return done
    const u = done.usage
    const effort = e.effort === undefined ? null : String(e.effort)
    // Ultracode goes out as xhigh: the picker's word for it stands.
    const shown = desktopPick?.effort === 'ultracode' && effort === 'xhigh' ? 'ultracode' : effort
    await update($, running, () => ({ model: u.model, effort: shown }))
    const family = familyOf(u.model)
    if (family) warm.set(family, { at: await $.clock.now(), tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens })
    if (lastStep && lastStep.model === u.model && lastStep.effort !== null && effort !== null && lastStep.effort !== effort) {
      effortBreaksCache = u.cache_creation_input_tokens > u.cache_read_input_tokens
    }
    lastStep = { model: u.model, effort }
    const sum = turnMix.get(e.turnId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    turnMix.set(e.turnId, {
      input: sum.input + u.input_tokens,
      output: sum.output + u.output_tokens,
      cacheRead: sum.cacheRead + u.cache_read_input_tokens,
      cacheWrite: sum.cacheWrite + u.cache_creation_input_tokens,
    })
    return done
  })

  // The engine's word that the chat's model moved (the footer's picker, /model): the band follows
  // at once, with the cache lifetime the engine runs on.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id === undefined) {
      reportedTtl = e.cache_ttl
      await update($, running, r => ({ model: e.to_model, effort: r?.effort ?? null }))
      await recompute($).catch(note)
    }
    return done
  })

  // An effort set through a settings row (an /effort command, a settings change) shows at once.
  on('config.set', async ($, e, next) => {
    const done = await next(e)
    if (!done.deny && /effort/i.test(e.key) && typeof done.value === 'string' && LEVELS.includes(done.value)) {
      const effort = done.value
      await update($, running, r => (r ? { ...r, effort } : r))
      await recompute($).catch(note)
    }
    return done
  })

  // A settings file changed (the effort among them): read the picker and the effort again now.
  on('classic.ConfigChange', async ($, e, next) => {
    const done = await next(e)
    void follow($).catch(note)
    return done
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
    draft = ''
    void recompute($).catch(note)
    return next(e)
  })

  // A finished turn is one message: its tokens join the last few, averaged.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const mix = e.agentId === undefined ? turnMix.get(e.turnId) : undefined
    turnMix.delete(e.turnId)
    if (mix) {
      recent = [...recent, mix].slice(-RECENT)
      const avg = (k: keyof Mix) => recent.reduce((a, m) => a + m[k], 0) / recent.length
      await update($, perMessage, () => ({ input: avg('input'), output: avg('output'), cacheRead: avg('cacheRead'), cacheWrite: avg('cacheWrite') }))
    }
    await recompute($).catch(note)
    return done
  })

  // Says what the mod sees: the model in use, the chat's tokens per message, any error.
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
        `draft seen: ${JSON.stringify(draft.slice(0, 60))}`,
        `judged by: ${await read($, mode)}`,
        `running on: ${(l => (l ? `${l.model} · ${l.effort ?? 'effort not reported'}` : 'unknown'))(await read($, running))}`,
        `picker (desktop record): ${desktopFile ? `${desktopPick?.model ?? 'model not set'} · ${desktopPick?.effort ?? 'effort not set'} · ${desktopFile}` : 'not found'}`,
        `billing: ${planSeen ? 'plan (usage limits)' : `credits (${identityKind ?? 'unknown login'})`} · cache lifetime: ${reportedTtl ?? `${planSeen ? '1h' : '5m'} (assumed)`}`,
        `models with a warm cache: ${[...warm].map(([f, w]) => `${f} ${kTokens(w.tokens)}`).join(', ') || 'none yet'}`,
        `band fit: ${lastFit ? `${lastFit.rows} of ${lastFit.maxRows} rows, ${lastFit.bodyColumns} columns` : 'not drawn yet'}`,
        `effort change re-reads the cache: ${effortBreaksCache === null ? 'not seen yet' : effortBreaksCache ? 'yes' : 'no'}`,
        `tokens per message: ${(m => (m ? `${Math.round(m.input)} in · ${Math.round(m.output)} out · ${Math.round(m.cacheRead)} cache read · ${Math.round(m.cacheWrite)} cache write` : 'not measured yet'))(await read($, perMessage))}`,
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
    // The title row: the name with Hide or Show right beside it, then how prompts are judged (the
    // switch, a row of its own no more: the band fits in fewer rows), then the summary while folded.
    const title = () => (
      <Box flexDirection="row" alignItems="center" width="100%" gap="lg">
        <Box flexShrink={0} flexDirection="row" alignItems="center" gap="md">
          <Text bold>Model hints</Text>
          <Button key="fold" plain dimColor label={isHidden ? 'Show' : 'Hide'} onPress={() => void fold($, !isHidden).catch(note)} />
        </Box>
        {toggle}
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
    if (!s) {
      return stack(section(isThinking ? 'thinking' : 'sleepy', labelled('Model', <Text dimColor>type a prompt for a suggestion</Text>)))
    }
    // The Model row: the model's mark and name, then its effort as the gauge and the word, when known;
    // after them, dim, anything the row adds. Each in its fixed slot, so nothing slides.
    const modelRow = (name: string, effort: string | null, after: string | null = null) => (
      <Box flexDirection="row" alignItems="center" width="100%" gap="lg">
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text dimColor>Model</Text>
        </Box>
        <Box width={NAME_WIDTH} flexShrink={0} flexDirection="row" alignItems="center" gap="sm">
          <Svg source={spark()} width={14} height={14} alt={name} />
          <Text bold>{name}</Text>
        </Box>
        <Box width={EFFORT_WIDTH} flexShrink={0} flexDirection="row" alignItems="center" gap="sm">
          {effort !== null && LEVELS.includes(effort) ? (
            <Svg source={gauge(effort)} width={GAUGE_W} height={14} alt={`${effort} effort`} />
          ) : null}
          {effort !== null && LEVELS.includes(effort) ? <Text dimColor>{levelName(effort)}</Text> : null}
        </Box>
        <Box flexGrow={1} flexShrink={1} flexDirection="row" justifyContent="center">
          {after ? <Text dimColor>{after}</Text> : null}
        </Box>
      </Box>
    )
    // An empty prompt box: the model the chat runs now, read live (the footer's picker moves it at
    // once), asleep until there's a prompt to judge.
    if (s.idle) {
      const run = (await read($, running)) ?? s.current
      const nowOn = TIERS.find(x => run.model.toLowerCase().includes(x.family))?.name
      const effort = run.effort?.toLowerCase() ?? null
      if (!nowOn) {
        return stack(section(isThinking ? 'thinking' : 'sleepy', labelled('Model', <Text dimColor>type a prompt for a suggestion</Text>)))
      }
      summary = effort && LEVELS.includes(effort) ? `${nowOn} · ${effort}` : nowOn
      return stack(section(isThinking ? 'thinking' : 'sleepy', modelRow(nowOn, effort, 'type a prompt for a suggestion')))
    }
    const t = TIERS[s.tier]!
    const warnings = s.warnings
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
    // The model the chat runs now: the footer's picker shows it, so the band only names it in the
    // savings it works out against it.
    const nowOn = TIERS.find(x => s.current.model.toLowerCase().includes(x.family))?.name
    // The reason leads, named for who gave it: Haiku's read of the prompt, or the word rules'.
    const reasonLine = line(
      <Text dimColor>{s.source === 'haiku' ? "Haiku's take" : 'Reason'}</Text>,
      <Text>{reasons.join('   ·   ')}</Text>,
    )
    // What the pick would save or cost against the model the chat runs on, on its own messages, and
    // what moving costs once: in shares of usage for a plan, in dollars at API prices for credits.
    // The person switches in the footer's picker; the band only advises.
    const c = s.compare
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    const altT = s.alt !== null ? TIERS[s.alt] : undefined
    const other = altT ?? t
    // One line where it can: what to do, the saving a message, and the one-off re-read with the
    // messages it takes to repay. Shares of usage on a plan; dollars at API prices on credits.
    const pct = (x: NonNullable<typeof c>) => `${Math.round((Math.abs(x.saving) / x.here) * 100)}%`
    const dollarsEach = (x: NonNullable<typeof c>) => (s.billing === 'plan' ? '' : ` (${dollars(x.there)} vs ${dollars(x.here)})`)
    const rereadOf = (x: NonNullable<typeof c>) =>
      x.warmMinutes !== null ? `${kTokens(x.lacks)} re-read (${other.name} cached ${x.warmMinutes} min ago)` : `${kTokens(s.contextTokens)} re-read`
    const once = (x: NonNullable<typeof c>) =>
      s.billing === 'plan'
        ? x.switchCost < x.here
          ? 'under a message'
          : `≈ ${plural(Math.round(x.switchCost / x.here), 'message')}`
        : dollars(x.switchCost)
    const estimate = c?.isEstimate ? ' (estimate)' : ''
    const savingsText = !c
      ? null
      : s.advice === 'switch'
        ? `Switch to ${t.name}: ${pct(c)} less ${s.billing === 'plan' ? 'usage ' : ''}a message${dollarsEach(c)}. The ${rereadOf(c)} costs ${once(c)}, repaid in ${plural(c.breakEven ?? 1, 'message')}.${estimate}`
        : s.advice === 'stay'
          ? `Stay on ${nowOn}. ${other.name} saves ${pct(c)} a message${dollarsEach(c)}, but its ${rereadOf(c)} takes ${plural(c.breakEven ?? 0, 'message')} to repay; a new chat avoids it.${estimate}`
          : `${t.name} needed: ${(c.there / c.here).toFixed(1)}× the ${s.billing === 'plan' ? 'usage' : 'cost'} a message${dollarsEach(c)}. The ${rereadOf(c)} costs ${once(c)}.${estimate}`
    // An effort the picker should change, said beside the model where there's room.
    const effortHint =
      s.current.effort && s.current.effort.toLowerCase() !== t.effort
        ? `pick ${levelName(t.effort)} in the picker${effortBreaksCache ? ' (re-reads too)' : ''}`
        : null
    const savingsLine = savingsText ? line(<Text dimColor>Cost</Text>, <Text>{savingsText}</Text>) : null
    // Top: the warnings when any, then why. Then one row read left to right: the label, the
    // suggested model and its effort, whether it's in use, and the actions at the end.
    summary = `${t.name} · ${t.effort}`
    const mood: Mood = isThinking ? 'thinking' : s.advice === 'switch' || s.advice === 'upgrade' ? 'pointing' : warnings.length ? 'puffed' : 'happy'
    // The band shows whole only within the rows the app gives it; past that it scrolls. So the
    // rows it can spare go first while it wouldn't fit: the note, then the reason.
    const textCols = Math.max(20, e.props.bodyColumns - LABEL_WIDTH - 4 - AVATAR_CLEAR)
    const rowsOf = (text: string | null) => (text ? Math.max(1, Math.ceil(text.length / textCols)) : 0)
    const belowRows = below ? 3 : 0
    let optional: { note: RenderElement | null; reason: RenderElement | null } = { note: warningLine, reason: reasonLine }
    const tall = () =>
      1 + (optional.note ? rowsOf(warnings.join('  ')) : 0) + (optional.reason ? rowsOf(reasons.join('   ·   ')) : 0) + rowsOf(savingsText) + 1 + belowRows
    if (tall() > e.props.maxRows) optional = { ...optional, note: null }
    if (tall() > e.props.maxRows) optional = { ...optional, reason: null }
    lastFit = { maxRows: e.props.maxRows, bodyColumns: e.props.bodyColumns, rows: tall() }
    const view = section(mood, optional.note, optional.reason, savingsLine, modelRow(t.name, t.effort, effortHint))
    return stack(view)
  })
}
