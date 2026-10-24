import type { EngineInterface, Register } from 'claude-code'

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const until = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'resetting now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`
}

// One line of text for the 5-hour window, or a waiting note before the first reading.
const limitLine = async ($: EngineInterface, width: number) => {
  const { rateLimits } = await $.session.usage()
  const five = rateLimits.find(r => r.kind === 'five_hour')
  if (!five) return '5h limit: no reading yet'
  const used = five.percentUsed
  const left = Math.max(0, Math.round((100 - used) * 10) / 10)
  const reset = until(five.resetsAt, await $.clock.now())
  return `5h ${bar(used, width)} ${used}% used · ${left}% left${reset ? ` · ${reset}` : ''}`
}

export const register: Register = on => {
  // Desktop app (Code tab): the footer beside the model name. Other mods' labels are kept after ours.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    try {
      const text = await limitLine($, 8)
      const { Box, Text } = $.ui.resolve(e)
      const below = await next(e)
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text dimColor>{text}</Text>
          {below}
        </Box>
      )
    } catch {
      return next(e)
    }
  })

  // Terminal: the dim hint line under the prompt.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    try {
      const hint = await limitLine($, 10)
      return next({ ...e, props: { ...e.props, hint } })
    } catch {
      return next(e)
    }
  })
}
