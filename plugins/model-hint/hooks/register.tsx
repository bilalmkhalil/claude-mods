import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Suggestion } from '../types'

// The last suggestion. Writing it redraws the band, which reads it.
const suggestion = atom({ plugin: 'model-hint', key: 'suggestion' } as const, null, { shape: 'suggestion-1' })

// Lightest first. `family` is matched against the model row's options and the session's model id.
const TIERS = [
  { family: 'haiku', name: 'Haiku 5.5', effort: 'low', why: 'quick task' },
  { family: 'sonnet', name: 'Sonnet 5.5', effort: 'medium', why: 'everyday coding' },
  { family: 'opus', name: 'Opus 5.5', effort: 'medium', why: 'multi-file work' },
  { family: 'opus', name: 'Opus 5.5', effort: 'high', why: 'hard problem' },
  { family: 'opus', name: 'Opus 5.5', effort: 'xhigh', why: 'deep reasoning' },
] as const

// The width of the band's label column, in cells; limit-hint's band uses the same so the two line up.
const LABEL_WIDTH = 10

// Each family's mark: a small spark in its own color.
const COLORS: Record<string, string> = { haiku: '#4fb39b', sonnet: '#6c9be0', opus: '#d97757' }
const spark = (family: string) => {
  const c = COLORS[family] ?? '#999999'
  const rays = [0, 45, 90, 135]
    .map(a => `<rect x="6.1" y="0.5" width="1.8" height="13" rx="0.9" fill="${c}" transform="rotate(${a} 7 7)"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${rays}</svg>`
}

// Effort as four rising bars, lit up to its level.
const LEVELS = ['low', 'medium', 'high', 'xhigh']
const gauge = (effort: string) => {
  const lit = LEVELS.indexOf(effort) + 1
  const bars = LEVELS.map((_, i) => {
    const h = 4 + i * 3
    return `<rect x="${i * 5}" y="${14 - h}" width="3" height="${h}" rx="1" fill="${i < lit ? '#b8b8b8' : '#8888884d'}"/>`
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
  let { tier, reasons } = score(text)
  const why = [TIERS[tier]!.why, ...reasons]

  // Room left in the limits: step down as they fill, and keep xhigh for when there's plenty.
  const used = Math.max(0, ...rateLimits.filter(r => r.kind === 'five_hour' || r.kind === 'seven_day').map(r => r.percentUsed))
  if (used >= 90) tier = Math.max(0, tier - 2)
  else if (used >= 75) tier = Math.max(0, tier - 1)
  else if (used >= 50) tier = Math.min(tier, 3)
  if (used >= 75) why.push(`limit ${used}% used`)

  // A full context makes every turn costly: think less, and say compacting helps.
  const fill = context.percent ?? 0
  if (fill >= 70) {
    if (tier >= 3) tier -= 1
    why.push(`context ${fill}% full · /compact helps`)
  }

  const modelRow = find(rows ?? [], /^model$|\bmodel\b/i)
  const effortRow = find(rows ?? [], /effort/i)
  const effort = effortRow && typeof effortRow.value === 'string' ? effortRow.value : null
  const canApply = settable(modelRow) && settable(effortRow)
  const next: Suggestion = { tier, reasons: why, current: { model: model ?? '', effort }, canApply }
  await update($, suggestion, () => next)
}

// Typing comes in bursts: work it out once the person pauses.
const schedule = ($: EngineInterface) => {
  pending?.cancel()
  pending = $.clock.after(300, () => void recompute($).catch(note))
}

const apply = async ($: EngineInterface, tier: number) => {
  const t = TIERS[tier]!
  const rows = await $.config.list()
  const modelRow = find(rows, /^model$|\bmodel\b/i)
  const effortRow = find(rows, /effort/i)
  const model = modelRow && modelValue(modelRow, t.family)
  const effort = effortRow && effortValue(effortRow, t.effort)
  if (!modelRow || !model || !effortRow || !effort) {
    $.ui.toast(`Couldn't switch to ${t.name} · ${t.effort} from here`)
    return
  }
  const a = await $.config.set({ key: modelRow.key, value: model })
  const b = a.deny ? a : await $.config.set({ key: effortRow.key, value: effort })
  if (b.deny) $.ui.toast(`Couldn't switch: ${b.deny}`)
  await recompute($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
    schedule($)
    return box
  })

  // Changes no keystroke made: a clear, a recalled entry, a plugin's fill.
  on('prompt.change', async ($, e, next) => {
    draft = e.text
    schedule($)
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
    if (!s) {
      return stack(
        <Box flexDirection="row" alignItems="center" width="100%" paddingX="sm" gap="lg">
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text dimColor>Model</Text>
          </Box>
          <Text dimColor>type a prompt for a suggestion</Text>
        </Box>,
      )
    }
    const t = TIERS[s.tier]!
    // The effort is the app's to show where no setting reports it: then the model alone decides.
    const fits =
      s.current.model.toLowerCase().includes(t.family) &&
      (s.current.effort === null || s.current.effort.toLowerCase() === t.effort)
    // Left: label, the model's mark and name, the effort gauge and word. Right: why, then Use.
    const row = (
      <Box flexDirection="row" alignItems="center" width="100%" paddingX="sm" gap="lg">
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text dimColor>{fits ? 'Model ✓' : 'Suggested'}</Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" alignItems="center" gap="sm">
          <Svg source={spark(t.family)} width={14} height={14} alt={t.name} />
          <Text bold>{t.name}</Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" alignItems="center" gap="sm">
          <Svg source={gauge(t.effort)} width={18} height={14} alt={`${t.effort} effort`} />
          <Text dimColor>{t.effort}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} flexDirection="row" justifyContent="flex-end" alignItems="center" gap="md">
          {s.reasons.flatMap((f, i) =>
            i ? [<Text dimColor>·</Text>, <Text dimColor wrap="truncate-end">{f}</Text>] : [<Text dimColor wrap="truncate-end">{f}</Text>],
          )}
        </Box>
        {s.canApply && !fits ? (
          <Box flexShrink={0}>
            <Button key="use" label="Use" onPress={() => void apply($, s.tier).catch(() => {})} />
          </Box>
        ) : null}
      </Box>
    )
    return stack(row)
  })
}
