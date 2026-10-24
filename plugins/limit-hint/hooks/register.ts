import type { Register } from 'claude-code'

const bar = (percent: number, width = 10) => {
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

export const register: Register = on => {
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    try {
      const { rateLimits } = await $.session.usage()
      const five = rateLimits.find(r => r.kind === 'five_hour')
      if (!five) {
        return next({ ...e, props: { ...e.props, hint: '5h limit: no reading yet (send a message)' } })
      }
      const used = five.percentUsed
      const left = Math.max(0, Math.round((100 - used) * 10) / 10)
      const reset = until(five.resetsAt, await $.clock.now())
      const hint = `5h limit ${bar(used)} ${used}% used · ${left}% left${reset ? ` · ${reset}` : ''}`
      return next({ ...e, props: { ...e.props, hint } })
    } catch {
      return next(e)
    }
  })
}
