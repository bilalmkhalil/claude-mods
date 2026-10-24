import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LimitReading } from '../types'

// The last 5-hour reading. Writing it redraws the footer and the hint line, which read it.
const reading = atom({ plugin: 'limit-hint', key: 'reading' } as const, null, { shape: 'reading-1' })

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// The bar's height in CSS pixels, about a line of the band's text.
const TRACK_HEIGHT = 12

const TRACK_COLOR = '#8888884d'
const fillColor = (used: number) => (used >= 90 ? '#e5484d' : used >= 75 ? '#e5a50a' : '#d97757')

// A straight stretch of one color. The markup is far wider than any band; the slot caps it and
// stretches it to fit (preserveAspectRatio none), so it has no corners of its own.
const middle = (color: string) => {
  const h = TRACK_HEIGHT
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${h}" viewBox="0 0 4000 ${h}" preserveAspectRatio="none">` +
    `<rect width="4000" height="${h}" fill="${color}"/>` +
    '</svg>'
  )
}

// A half-round end, drawn at its own size so it stays round however wide the middle is. `behind`
// fills its corners where it ends inside the track (the fill's right end).
const cap = (side: 'left' | 'right', color: string, behind?: string) => {
  const h = TRACK_HEIGHT
  const r = h / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${h}" viewBox="0 0 ${r} ${h}">` +
    (behind ? `<rect width="${r}" height="${h}" fill="${behind}"/>` : '') +
    `<rect x="${side === 'left' ? 0 : -r}" width="${h}" height="${h}" rx="${r}" fill="${color}"/>` +
    '</svg>'
  )
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

  // Desktop app (Code tab): the footer beside the model name only draws a short label,
  // so it carries just the figure. Other mods' labels are kept after ours.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const r = await read($, reading)
    const label = r ? `5h · ${r.used}%` : '5h · –'
    return next({ ...e, props: { ...e.props, modes: [label, ...e.props.modes] } })
  })

  // Desktop app (Code tab): a full-width band above the prompt with the bar and the figures.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const r = await read($, reading)
    if (!r) return next(e)
    const { Box, Svg, Text } = $.ui.resolve(e)
    const used = Math.max(0, Math.min(100, r.used))
    const left = Math.max(0, Math.round((100 - r.used) * 10) / 10)
    const reset = until(r.resetsAt, r.at)
    const figures = [`${r.used}% used`, `${left}% left`, ...(reset ? [reset] : [])]
    const fill = fillColor(used)
    // Every piece carries an alt: the surface drops an Svg whose alt is empty.
    const alt = `${r.used}% of the 5-hour limit used`
    const end = (side: 'left' | 'right', color: string, behind?: string) => (
      <Svg source={cap(side, color, behind)} width={TRACK_HEIGHT / 2} height={TRACK_HEIGHT} alt={alt} />
    )
    const stretch = (color: string, grow: number) => (
      <Box flexGrow={grow} flexShrink={1}>
        <Svg source={middle(color)} height={TRACK_HEIGHT} alt={alt} />
      </Box>
    )
    // The fill is a pill of its own, its right end round over the track; the track runs on after it.
    // The two stretches split the room by their grow, the fill's share being `used`.
    const bar =
      used <= 0
        ? [end('left', TRACK_COLOR), stretch(TRACK_COLOR, 1), end('right', TRACK_COLOR)]
        : used >= 100
          ? [end('left', fill), stretch(fill, 1), end('right', fill)]
          : [
              end('left', fill),
              stretch(fill, used),
              end('right', fill, TRACK_COLOR),
              stretch(TRACK_COLOR, 100 - used),
              end('right', TRACK_COLOR),
            ]
    return (
      <Box flexDirection="row" alignItems="center" width="100%" paddingX="sm" gap="lg">
        <Box flexShrink={0}>
          <Text dimColor>5h limit</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={8} flexDirection="row" alignItems="center">
          {bar}
        </Box>
        <Box flexShrink={0} flexDirection="row" alignItems="center" gap="md">
          {figures.flatMap((f, i) => (i ? [<Text dimColor>·</Text>, <Text dimColor>{f}</Text>] : [<Text dimColor>{f}</Text>]))}
        </Box>
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
