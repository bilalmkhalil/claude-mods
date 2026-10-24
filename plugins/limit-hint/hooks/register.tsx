import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LimitReading } from '../types'

// The last 5-hour reading. Writing it redraws the footer and the hint line, which read it.
const reading = atom({ plugin: 'limit-hint', key: 'reading' } as const, null, { shape: 'reading-1' })

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const until = (iso: string | null, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'resetting now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`
}

// Takes a fresh reading; keeps the last one (with a new clock time) when the engine has none right now.
const refresh = async ($: EngineInterface) => {
  const { rateLimits } = await $.session.usage()
  const five = rateLimits.find(r => r.kind === 'five_hour')
  const at = await $.clock.now()
  const fresh: LimitReading | null = five ? { used: five.percentUsed, resetsAt: five.resetsAt ?? null, at } : null
  await update($, reading, prev => fresh ?? (prev ? { ...prev, at } : null))
}

const line = (r: LimitReading | null, width: number) => {
  if (!r) return '5h limit: no reading yet (updates after a reply)'
  const left = Math.max(0, Math.round((100 - r.used) * 10) / 10)
  const reset = until(r.resetsAt, r.at)
  return `5h ${bar(r.used, width)} ${r.used}% used · ${left}% left${reset ? ` · ${reset}` : ''}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void refresh($).catch(() => {})
    // Once a minute: moves the reset countdown and picks up a reading taken elsewhere.
    $.clock.every(60_000, () => void refresh($).catch(() => {}))
    return next(e)
  })

  // After every reply: the response just reported the limit.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($).catch(() => {})
    return done
  })

  // Desktop app (Code tab): the footer beside the model name. Other mods' labels are kept after ours.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const r = await read($, reading)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text dimColor>{line(r, 8)}</Text>
        {below}
      </Box>
    )
  })

  // Terminal: the dim hint line under the prompt.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const r = await read($, reading)
    return next({ ...e, props: { ...e.props, hint: line(r, 10) } })
  })
}
