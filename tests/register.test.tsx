import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const ROOT = '/stack/sites/app'
const LOG = `${ROOT}/wp-content/debug.log`
const S = '[22-Oct-2026 14:30:00 UTC] '
const FATAL = `${S}PHP Fatal error:  Uncaught Error: Call to undefined function foo() in /var/www/app/src/Foo.php:42\nStack trace:\n#0 {main}\n`
const NOTICE = `${S}PHP Notice:  Undefined index: x in /var/www/app/src/Bar.php on line 3\n`

// A WordPress site at /stack/sites/app whose debug.log the test writes to.
function world(on: On, start = 'old line\n') {
  const files: Record<string, string> = { [LOG]: start }
  const dirs = new Set([`${ROOT}/wp-content`])
  const sent: string[] = []
  const filled: string[] = []
  const clock = mock.clock(on, { now: 1000 })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.stat', ($, e) => {
    if (dirs.has(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('process.run', ($, e) => {
    const [cmd, , n, path] = e.argv
    const text = cmd === 'tail' && path !== undefined ? (files[path] ?? '') : ''
    return { value: { exitCode: 0, stdout: text.slice(text.length - Number(n)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: ROOT }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  const append = (text: string) => {
    files[LOG] = (files[LOG] ?? '') + text
  }
  return { files, sent, filled, clock, append }
}

// The test's `$` also raises session.start, which a plugin's `$` cannot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function begin($: any, clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start({ source: 'startup', cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1)
}

const BASH = { tool: 'Bash', command: 'curl -s https://app.test/' } as never

test('an error during a turn is added to what Claude reads after the tool call', async ($, on) => {
  const w = world(on)
  await begin($, w.clock)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  w.append(FATAL)
  const result = await $.tool.call(BASH)
  const context = (result as { context?: readonly string[] }).context ?? []
  expect(context.length).toBe(1)
  expect(context[0]?.includes('[Fatal] Uncaught Error: Call to undefined function foo()')).toBe(true)
  expect(context[0]?.includes('src/Foo.php:42')).toBe(true)
  // Told once: the next call carries nothing new.
  const again = await $.tool.call(BASH)
  expect((again as { context?: readonly string[] }).context).toBeUndefined()
})

test('errors from before the session or the turn are not told; notices are not told', async ($, on) => {
  const w = world(on, FATAL)
  await begin($, w.clock)
  w.append(FATAL)
  await w.clock.advance(3000)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  w.append(NOTICE)
  const result = await $.tool.call(BASH)
  expect((result as { context?: readonly string[] }).context).toBeUndefined()
})

test('tellClaude off: nothing is added', { options: { tellClaude: false } }, async ($, on) => {
  const w = world(on)
  await begin($, w.clock)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  w.append(FATAL)
  const result = await $.tool.call(BASH)
  expect((result as { context?: readonly string[] }).context).toBeUndefined()
})

test('the band shows new errors; Fix sends one to Claude; Dismiss hides it', async ($, on) => {
  const w = world(on)
  await begin($, w.clock)
  w.append(FATAL + FATAL)
  await w.clock.advance(3000)
  const ui = await $.ui.mount({ plugin: 'clawd-logs', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 } as never })
  expect(await ui.find({ type: 'Text', text: /Call to undefined function foo\(\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ×2' })).toBeDefined()
  await ui.press({ key: 'fix' })
  expect(w.sent.length).toBe(1)
  expect(w.sent[0]?.includes('```\nPHP Fatal error')).toBe(true)
  expect(await ui.find({ key: 'fix' })).toBeUndefined()
  w.append(FATAL)
  await w.clock.advance(3000)
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
})

test('a rotated or emptied log is read again from its start', async ($, on) => {
  const w = world(on, 'x'.repeat(5000) + '\n')
  await begin($, w.clock)
  w.files[LOG] = FATAL
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  const before = await $.command.run({ command: 'logs', args: '' } as never)
  expect(String((before as { text?: string }).text).includes('Call to undefined function foo()')).toBe(true)
})

test('/logs lists, fixes by number, clears and pauses', async ($, on) => {
  const w = world(on)
  await begin($, w.clock)
  w.append(FATAL + NOTICE)
  const list = String(((await $.command.run({ command: 'logs', args: '' } as never)) as { text?: string }).text)
  expect(list.includes('Watching: wp-content/debug.log')).toBe(true)
  expect(list.includes(' 1. [Fatal]')).toBe(true)
  expect(list.includes('(1 below warning hidden)')).toBe(true)
  const fixed = String(((await $.command.run({ command: 'logs', args: 'fix 1' } as never)) as { text?: string }).text)
  expect(fixed.includes('press Enter')).toBe(true)
  expect(w.filled[0]?.includes('Call to undefined function foo()')).toBe(true)
  await $.command.run({ command: 'logs', args: 'clear' } as never)
  const empty = String(((await $.command.run({ command: 'logs', args: '' } as never)) as { text?: string }).text)
  expect(empty.includes('No new errors this session.')).toBe(true)
  await $.command.run({ command: 'logs', args: 'off' } as never)
  await $.turn.start({ turnId: 't2', text: 'go' } as never)
  w.append(FATAL)
  expect(((await $.tool.call(BASH)) as { context?: readonly string[] }).context).toBeUndefined()
})
