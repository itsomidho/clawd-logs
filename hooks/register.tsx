// clawd-logs: watches the project's error logs. New errors show above the
// prompt, grouped, with a Fix button; the ones that appear while Claude works
// are added to what Claude reads after its next tool call.

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import {
  LEVEL_LABEL,
  addEntries,
  bandLine,
  findSources,
  fixText,
  headline,
  oneLine,
  parseConfigFile,
  parseEntries,
  parseLevel,
  isDebuggable,
  localPath,
  relative,
  tellText,
  visible,
  wholeLines,
} from './logs'
import type { Config, Group, Level } from './logs'

const PLUGIN = 'clawd-logs'
const CONFIG_NAME = 'clawd-logs.json'
// The most read from one file at once; past it, only the newest part.
const MAX_READ = 512 * 1024

const groups = atom({ plugin: 'clawd-logs', key: 'groups' } as const, [])
const dismissedAt = atom({ plugin: 'clawd-logs', key: 'dismissedAt' } as const, 0)
const isPaused = atom({ plugin: 'clawd-logs', key: 'isPaused' } as const, false)
const sources = atom({ plugin: 'clawd-logs', key: 'sources' } as const, [])

type Settings = { minLevel: Level; tellClaude: boolean; intervalMs: number }

// Per load: where each file was read up to, what is waiting to be told to
// Claude, and whether a turn of the main conversation is running.
const ctx = {
  settings: { minLevel: 'warning', tellClaude: true, intervalMs: 2000 } as Settings,
  offsets: new Map<string, number>(),
  pending: new Map<string, number>(),
  isTurn: false,
  scanning: null as Promise<void> | null,
  root: '',
  // The level the band shows from: the setting, or a config file's.
  minLevel: 'warning' as Level,
}

async function homeDir($: Engine): Promise<string | undefined> {
  try {
    return await $.env.get('HOME')
  } catch {
    return undefined
  }
}

async function readOptional($: Engine, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined
  } catch {
    return undefined
  }
}

async function isDir($: Engine, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

async function sizeOf($: Engine, path: string): Promise<number | undefined> {
  try {
    const s = await $.fs.stat(path)
    return s.kind === 'file' ? s.size : undefined
  } catch {
    return undefined
  }
}

// The settings, then ~/.claude/clawd-logs.json, then the project's
// .claude/clawd-logs.json.
async function loadConfig($: Engine, root: string): Promise<{ config: Config; errors: string[] }> {
  const home = await homeDir($)
  const config: Config = { sources: [], minLevel: ctx.settings.minLevel, tellClaude: ctx.settings.tellClaude }
  const errors: string[] = []
  for (const path of [...(home === undefined ? [] : [`${home}/.claude/${CONFIG_NAME}`]), `${root}/.claude/${CONFIG_NAME}`]) {
    const text = await readOptional($, path)
    if (text === undefined) continue
    try {
      const file = parseConfigFile(text)
      config.sources.push(...(file.sources ?? []))
      if (file.minLevel !== undefined) config.minLevel = file.minLevel
      if (file.tellClaude !== undefined) config.tellClaude = file.tellClaude
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { config, errors }
}

async function configOf($: Engine): Promise<Config> {
  return (await loadConfig($, ctx.root)).config
}

// The new bytes of a file since the last read, as whole lines.
async function readNew($: Engine, path: string): Promise<string> {
  const size = await sizeOf($, path)
  if (size === undefined) {
    // Gone (rotated away, not created yet): start from its beginning next time.
    ctx.offsets.set(path, 0)
    return ''
  }
  let from = ctx.offsets.get(path) ?? 0
  // Emptied or rotated to a fresh file: read the new one from the start.
  if (size < from) from = 0
  const delta = size - from
  if (delta <= 0) return ''
  const want = Math.min(delta, MAX_READ)
  let text: string
  try {
    const r = await $.process.run(['tail', '-c', String(want), path], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return ''
    text = r.stdout
  } catch {
    return ''
  }
  // When only the newest part was read, its first line is cut: drop it.
  if (delta > MAX_READ) {
    const firstEnd = text.indexOf('\n')
    text = firstEnd < 0 ? '' : text.slice(firstEnd + 1)
    ctx.offsets.set(path, size)
    return text
  }
  const whole = wholeLines(text)
  ctx.offsets.set(path, from + whole.bytes)
  return whole.text
}

// Reads every source's new lines into the groups. One scan at a time.
async function scan($: Engine): Promise<void> {
  if (ctx.scanning !== null) return ctx.scanning
  ctx.scanning = (async () => {
    const paths = await read($, sources)
    const now = await $.clock.now()
    for (const path of paths) {
      const text = await readNew($, path)
      if (text === '') continue
      const entries = parseEntries(text)
      if (entries.length === 0) continue
      let seen = new Map<string, number>()
      await update($, groups, old => {
        const added = addEntries(old, path, entries, now)
        seen = added.seen
        return added.groups
      })
      if (ctx.isTurn) for (const [key, n] of seen) ctx.pending.set(key, (ctx.pending.get(key) ?? 0) + n)
    }
  })().finally(() => {
    ctx.scanning = null
  })
  return ctx.scanning
}

// Starts each source at its current end, so only errors from now on count.
async function startSources($: Engine): Promise<void> {
  const root = await $.session.root()
  ctx.root = root
  const config = await configOf($)
  ctx.minLevel = config.minLevel ?? ctx.settings.minLevel
  const found = await findSources(root, await homeDir($), config.sources, path => isDir($, path))
  ctx.offsets.clear()
  for (const path of found) ctx.offsets.set(path, (await sizeOf($, path)) ?? 0)
  await update($, sources, () => found)
}

// The errors waiting to be told to Claude, as text; empties the wait.
async function takePending($: Engine): Promise<string | null> {
  if (ctx.pending.size === 0) return null
  const config = await configOf($)
  const min = config.minLevel ?? ctx.settings.minLevel
  const all = await read($, groups)
  const news = [...ctx.pending]
    .map(([key, times]) => ({ group: all.find(g => g.key === key), times }))
    .filter((one): one is { group: Group; times: number } => one.group !== undefined)
    .filter(one => visible([one.group], min).length > 0)
  ctx.pending.clear()
  if (config.tellClaude === false || news.length === 0) return null
  return tellText(news, ctx.root)
}

function listText(all: readonly Group[], min: Level, root: string, paths: readonly string[], isOff: boolean): string {
  const shown = visible(all, min).sort((a, b) => b.lastAt - a.lastAt)
  const hidden = all.length - shown.length
  const lines = [
    `📜 clawd-logs ${isOff ? 'is PAUSED (/logs on to resume)' : 'is on'} · showing ${LEVEL_LABEL[min].toLowerCase()} and up`,
    paths.length > 0 ? `Watching: ${paths.map(p => relative(root, p)).join(', ')}` : 'Watching: nothing found (add "sources" to .claude/clawd-logs.json)',
    '',
    ...(shown.length === 0
      ? ['No new errors this session.']
      : shown.slice(0, 30).map((g, i) => `${String(i + 1).padStart(2)}. [${LEVEL_LABEL[g.level]}] ${oneLine(g, root)}${g.count > 1 ? ` ×${g.count}` : ''}`)),
    ...(shown.length > 30 ? [`… and ${shown.length - 30} more`] : []),
    ...(hidden > 0 ? [`(${hidden} below ${LEVEL_LABEL[min].toLowerCase()} hidden)`] : []),
    '',
    '/logs fix <n> puts a fix request in the prompt box · /logs clear · /logs off | on',
  ]
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  ctx.settings = {
    minLevel: parseLevel(options.minLevel),
    tellClaude: options.tellClaude !== false,
    intervalMs: Math.max(1, Number(options.refreshSeconds ?? 2) || 2) * 1000,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'logs',
      description: 'clawd-logs: new errors in the project\'s logs; "fix <n>", "clear", "off" / "on"',
      argumentHint: '[fix <n> | clear | off | on]',
    }).catch(() => {})
    const started = await next(e)
    void (async () => {
      await startSources($)
      $.clock.every(ctx.settings.intervalMs, () => {
        void (async () => {
          if (!(await read($, isPaused))) await scan($)
        })().catch(() => {})
      })
    })().catch(() => {})
    return started
  })

  // A turn begins: what was already in the logs is not this turn's doing.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await scan($).catch(() => {})
      ctx.pending.clear()
      ctx.isTurn = true
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      ctx.isTurn = false
      ctx.pending.clear()
    }
    return done
  }).catch(($, e, next) => next(e))

  // After each tool call: read the logs, and tell Claude what is new.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || !ctx.isTurn || (await read($, isPaused))) return result
    await scan($)
    const text = await takePending($)
    if (text === null) return result
    return { ...result, context: [...(result.context ?? []), text] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'logs' }, async ($, e) => {
    const [verb = '', arg = ''] = String(e.args ?? '').trim().split(/\s+/)
    const min = (await configOf($)).minLevel ?? ctx.settings.minLevel
    if (verb === 'off' || verb === 'on') {
      await update($, isPaused, () => verb === 'off')
      return { text: verb === 'off' ? '📜 clawd-logs paused for this session.' : '📜 clawd-logs is on.' }
    }
    if (verb === 'clear') {
      await update($, groups, () => [])
      ctx.pending.clear()
      return { text: '📜 clawd-logs: the list is cleared.' }
    }
    if (verb === 'fix') {
      const shown = visible(await read($, groups), min).sort((a, b) => b.lastAt - a.lastAt)
      const pick = shown[Math.max(0, (Number(arg) || 1) - 1)]
      if (pick === undefined) return { text: '📜 clawd-logs: no such error; /logs lists them.' }
      // A command cannot start a turn while it runs: the request goes in the
      // prompt box, to send with Enter.
      const filled = await $.prompt.fill({ text: fixText(pick, ctx.root) }).then(r => r.isFilled).catch(() => false)
      return filled
        ? { text: '📜 The fix request is in the prompt box: press Enter to send it.' }
        : { text: '📜 Could not fill the prompt box. Ask Claude to fix this:\n\n' + fixText(pick, ctx.root) }
    }
    await scan($).catch(() => {})
    return { text: listText(await read($, groups), min, ctx.root, await read($, sources), await read($, isPaused)) }
  })

  // The band above the prompt: the newest errors since the last Dismiss.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaused))) return next(e)
    const since = await read($, dismissedAt)
    const min = ctx.minLevel
    const fresh = visible(await read($, groups), min).filter(g => g.lastAt > since)
    const top = headline(fresh)
    if (top === undefined) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // With clawd-debug loaded, an error that points at a file and line it can
    // run gets a Debug button: a breakpoint there, the file in its pane.
    const debugAt = top.file && top.line && isDebuggable(top.file) && (await hasDebugger($))
      ? `${localPath(ctx.root, top.file)}:${top.line}`
      : ''
    const total = fresh.length
    // The message's room: the row less everything else on it, counted as
    // drawn (a Button is its label in "[ … ]"), so the row fits exactly; one
    // cell more and the message would wrap onto a second line.
    const label = ` ${LEVEL_LABEL[top.level].toUpperCase()} `
    const counts = `${label} ${total} new · `.length + (top.count > 1 ? ` ×${top.count}`.length : 0)
    const buttons = ' [ Fix ] '.length + (debugAt ? '[ Debug ] '.length : 0) + '[ Dismiss ]'.length
    const room = Math.max(20, e.props.bodyColumns - 4 - counts - buttons)
    const summary = bandLine(top, ctx.root, room)
    const color = top.level === 'warning' || top.level === 'notice' ? WARN : ERR
    const band = (
      <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="row">
        <Text bold color={CHIP_TEXT} backgroundColor={color}>{` ${LEVEL_LABEL[top.level].toUpperCase()} `}</Text>
        <Text> </Text>
        <Text bold>{total}</Text>
        <Text dimColor>{total === 1 ? ' new · ' : ' new · '}</Text>
        <Text wrap="truncate-end">{summary}</Text>
        {top.count > 1 ? <Text dimColor>{` ×${top.count}`}</Text> : null}
        <Text> </Text>
        <Button key="fix" label="Fix" onPress={async () => {
          await $.prompt.submit({ text: fixText(top, ctx.root) }).catch(() => {})
          await update($, dismissedAt, () => top.lastAt)
        }} />
        <Text> </Text>
        {debugAt ? <Button key="debug" label="Debug" onPress={async () => {
          await $.command.run({ command: 'dbg', args: `break ${debugAt}` }).catch(() => {})
        }} /> : null}
        {debugAt ? <Text> </Text> : null}
        <Button key="dismiss" label="Dismiss" onPress={async () => {
          const latest = (await read($, groups)).reduce((t, g) => Math.max(t, g.lastAt), 0)
          await update($, dismissedAt, () => latest)
        }} />
      </Box>
    )
    return below ? <Box flexDirection="column">{band}{below as never}</Box> : band
  })
}

// clawd-debug (a separate plugin) registers /dbg; the Debug button shows only then.
async function hasDebugger($: Engine): Promise<boolean> {
  const commands = await $.command.list().catch(() => [])
  return commands.some(one => one.name === 'dbg')
}

// The clawd family's look (shared with clawd-git and clawd-debug): the accent,
// the frame colour, and chips (dark text on a colour).
const BORDER = '#5c6370'
const CHIP_TEXT = '#1e2127'
const WARN = '#e5c07b'
const ERR = '#e06c75'

