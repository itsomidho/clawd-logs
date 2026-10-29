// Pure log logic: parsing, levels, grouping and the text Claude reads.
// No engine calls, so all of it is testable on its own.

export type Level = import('../types').LogLevel

export const LEVELS: readonly Level[] = ['notice', 'warning', 'error', 'fatal']

export function rank(level: Level): number {
  return LEVELS.indexOf(level)
}

export function parseLevel(value: unknown, fallback: Level = 'warning'): Level {
  return LEVELS.find(one => one === value) ?? fallback
}

// One log entry: its first line's message, and the lines that followed it
// (a stack trace).
export type Entry = {
  level: Level
  message: string
  file?: string
  line?: number
  text: string
}

export type Group = import('../types').LogGroup

const MAX_MESSAGE = 300
const MAX_SAMPLE = 4000

// ---------- parsing ----------

// `[22-Oct-2026 14:30:00 UTC] PHP Fatal error: …` (PHP's error_log format).
const PHP_STAMP = /^\[\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}(?: [A-Za-z_/+-]+)?\] /
// `2026/10/22 14:47:01 [error] 31#31: *1 …` (nginx's error log).
const NGINX_LINE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \[(\w+)\] \d+#\d+: (?:\*\d+ )?(.*)$/
// Other logs' leading timestamps: ISO dates, `[2026-10-22 …]`, `Oct 22 14:30:00`.
const OTHER_STAMP = /^(?:\[[^\]]{8,40}\]\s*|\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\s*|[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}\s*)/

function phpLevel(message: string): Level {
  if (/^PHP (Fatal|Parse|Recoverable fatal|Compile) error/i.test(message) || /\bUncaught\b/.test(message)) return 'fatal'
  if (/^WordPress database error/i.test(message) || /^PHP (Error|Exception)\b/.test(message)) return 'error'
  if (/^PHP Warning/i.test(message)) return 'warning'
  return 'notice'
}

function nginxLevel(word: string, message: string): Level {
  if (/PHP message: PHP (Fatal|Parse) error|Uncaught/.test(message)) return 'fatal'
  if (word === 'emerg' || word === 'alert' || word === 'crit') return 'fatal'
  if (word === 'error') return /PHP message: PHP Warning/.test(message) ? 'warning' : 'error'
  if (word === 'warn') return 'warning'
  return 'notice'
}

function otherLevel(message: string): Level {
  if (/\b(fatal|critical|emerg(ency)?|panic)\b/i.test(message)) return 'fatal'
  if (/\b(error|exception|failed)\b/i.test(message)) return 'error'
  if (/\bwarn(ing)?\b/i.test(message)) return 'warning'
  return 'notice'
}

// Where an entry points: `in /path/file.php on line 42`, `/path/file.php:42`.
function location(message: string): { file?: string; line?: number } {
  const m = /((?:phar:\/\/)?\/[^\s'"():,]+\.\w+)(?: on line |:|\()(\d+)\)?/.exec(message)
  return m === null ? {} : { file: m[1], line: Number(m[2]) }
}

function entry(level: Level, message: string, lines: string[]): Entry {
  const where = location(message)
  return { level, message, ...where, text: lines.join('\n') }
}

// Splits a chunk of log text into entries. A line that does not start a new
// entry (a stack trace, `thrown in`) belongs to the one before it.
export function parseEntries(text: string): Entry[] {
  const entries: Entry[] = []
  let current: { level: Level; message: string; lines: string[] } | null = null
  const flush = () => {
    if (current !== null) entries.push(entry(current.level, current.message, current.lines))
    current = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (PHP_STAMP.test(line)) {
      const message = line.replace(PHP_STAMP, '')
      // Xdebug stamps each line of its stack trace: they belong to the error above.
      if (current !== null && /^PHP (Stack trace:|\s+\d+\. )/.test(message)) {
        ;(current as { lines: string[] }).lines.push(message)
        continue
      }
      flush()
      current = { level: phpLevel(message), message, lines: [message] }
      continue
    }
    const nginx = NGINX_LINE.exec(line)
    if (nginx !== null) {
      flush()
      const message = nginx[2] ?? ''
      current = { level: nginxLevel(nginx[1] ?? '', message), message, lines: [message] }
      continue
    }
    const isContinuation = /^(\s|#\d+ |Stack trace:|thrown in |Next )/.test(line)
    if (isContinuation && current !== null) {
      ;(current as { lines: string[] }).lines.push(line)
      continue
    }
    flush()
    const message = line.replace(OTHER_STAMP, '')
    current = { level: otherLevel(message), message, lines: [message] }
  }
  flush()
  return entries
}

// ---------- grouping ----------

// What stays the same when one error repeats: values, ids, URLs and numbers
// become placeholders, and WordPress's "made by" call chain is dropped.
export function normalize(message: string): string {
  return message
    .replace(/ made by .*$/s, '')
    .replace(/, client: .*$/s, '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'…'")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function keyOf(source: string, e: Entry): string {
  const where = e.file === undefined ? '' : `${e.file}:${e.line ?? ''}`
  return `${source}|${e.level}|${where}|${normalize(e.message.replace(/ in \/\S+ on line \d+/, ''))}`
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// Adds entries to the groups. Returns the groups and how many times each key
// was seen in this batch.
export function addEntries(
  groups: readonly Group[],
  source: string,
  entries: readonly Entry[],
  now: number,
  maxGroups = 200,
): { groups: Group[]; seen: Map<string, number> } {
  const byKey = new Map(groups.map(g => [g.key, { ...g }]))
  const seen = new Map<string, number>()
  for (const e of entries) {
    const key = keyOf(source, e)
    seen.set(key, (seen.get(key) ?? 0) + 1)
    const old = byKey.get(key)
    if (old !== undefined) {
      old.count += 1
      old.lastAt = now
      continue
    }
    byKey.set(key, {
      key,
      level: e.level,
      message: clip(e.message.replace(/ made by .*$/s, ''), MAX_MESSAGE),
      ...(e.file === undefined ? {} : { file: e.file }),
      ...(e.line === undefined ? {} : { line: e.line }),
      source,
      count: 1,
      firstAt: now,
      lastAt: now,
      sample: clip(e.text, MAX_SAMPLE),
    })
  }
  // The newest stay when there are too many.
  const all = [...byKey.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, maxGroups)
  return { groups: all, seen }
}

export function visible(groups: readonly Group[], minLevel: Level): Group[] {
  return groups.filter(g => rank(g.level) >= rank(minLevel))
}

// The one the band shows: the most severe, then the latest.
export function headline(groups: readonly Group[]): Group | undefined {
  return [...groups].sort((a, b) => rank(b.level) - rank(a.level) || b.lastAt - a.lastAt)[0]
}

// ---------- text ----------

export const LEVEL_LABEL: Record<Level, string> = { fatal: 'Fatal', error: 'Error', warning: 'Warning', notice: 'Notice' }

// A path as seen from the project. One from inside a container
// (/var/www/<site>/…) is matched on the project folder's name.
export function relative(root: string, path: string): string {
  if (path.startsWith(root + '/')) return path.slice(root.length + 1)
  const name = root.slice(root.lastIndexOf('/') + 1)
  const at = name === '' ? -1 : path.indexOf(`/${name}/`)
  return at >= 0 ? path.slice(at + name.length + 2) : path
}

// Where a path is on this machine: one from inside a container is put under
// the project folder; one that is not the project's stays as it was.
export function localPath(root: string, path: string): string {
  const rel = relative(root, path)
  return rel === path ? path : `${root}/${rel}`
}

// A file clawd-debug can run: PHP, Python, JavaScript.
export function isDebuggable(path: string): boolean {
  return /\.(php|phtml|py|pyw|js|mjs|cjs)$/i.test(path)
}

// The message without its PHP prefix, and where it points, for one line.
export function oneLine(g: Group, root: string): string {
  const message = g.message
    .replace(/^PHP (Fatal error|Parse error|Warning|Notice|Deprecated|Recoverable fatal error):\s*/, '')
    .replace(/^FastCGI sent in stderr: "PHP message: (PHP )?/, '')
    .replace(/ in (?:phar:\/\/)?\/\S+?(?: on line \d+|:\d+|\(\d+\)).*$/s, '')
  const where = g.file === undefined ? '' : ` · ${relative(root, g.file)}:${g.line ?? ''}`
  return `${message}${where}`
}

// A path cut to `max` characters from the middle, so its start and its file
// name (with its folder, when there is room) both stay.
export function shortenPath(path: string, max: number): string {
  if (path.length <= max) return path
  if (max < 2) return '…'
  const name = path.slice(path.lastIndexOf('/'))
  const cut = path.lastIndexOf('/', path.length - name.length - 1)
  const parent = cut < 0 ? name : path.slice(cut)
  const keep = parent.length <= max - 7 ? parent : name
  const tail = Math.min(max - 1, Math.max(keep.length, Math.floor((max - 1) / 2)))
  return path.slice(0, max - 1 - tail) + '…' + path.slice(path.length - tail)
}

// The band's two rows on a narrow screen: the message in `messageRoom`
// characters, and where it points (file:line) in `whereRoom`, each cut on its own.
export function bandParts(g: Group, root: string, messageRoom: number, whereRoom: number): { message: string; where: string } {
  const line = oneLine(g, root)
  const at = g.file === undefined ? -1 : line.lastIndexOf(' · ')
  const message = at < 0 ? line : line.slice(0, at)
  const where = g.file === undefined ? '' : shortenPath(`${relative(root, g.file)}:${g.line ?? ''}`, Math.max(12, whereRoom))
  return { message: message.length > messageRoom ? message.slice(0, Math.max(0, messageRoom - 1)) + '…' : message, where }
}

// oneLine fitted to `room` characters for the band: the message is cut
// first, so where the error points (file:line) stays readable.
export function bandLine(g: Group, root: string, room: number): string {
  const line = oneLine(g, root)
  if (line.length <= room) return line
  if (g.file === undefined) return line.slice(0, Math.max(0, room - 1)) + '…'
  const where = shortenPath(`${relative(root, g.file)}:${g.line ?? ''}`, Math.max(12, Math.floor(room / 2)))
  const message = line.slice(0, line.lastIndexOf(' · '))
  const space = room - where.length - 3
  return `${message.length > space ? message.slice(0, Math.max(0, space - 1)) + '…' : message} · ${where}`
}

// What Claude reads after a tool call: the new errors, most severe first, the
// stack of the first one, and what to do.
export function tellText(news: readonly { group: Group; times: number }[], root: string, max = 5): string {
  const sorted = [...news].sort((a, b) => rank(b.group.level) - rank(a.group.level))
  const lines = sorted.slice(0, max).map(({ group, times }) =>
    `- [${LEVEL_LABEL[group.level]}] ${clip(oneLine(group, root), 240)}${times > 1 ? ` (×${times})` : ''} — ${relative(root, group.source)}`)
  const more = sorted.length - max
  const first = sorted[0]?.group
  const stack = first !== undefined && first.sample.includes('\n') ? `\nFirst one in full:\n${clip(first.sample, 1500)}` : ''
  return [
    `clawd-logs: ${sorted.length === 1 ? 'a new error' : `${sorted.length} new errors`} appeared in the project's logs during this step:`,
    ...lines,
    ...(more > 0 ? [`- and ${more} more (/logs lists them)`] : []),
    stack,
    'If your change could have caused this, look into it before you finish.',
  ].filter(line => line !== '').join('\n')
}

// The message the Fix button sends.
export function fixText(g: Group, root: string): string {
  return [
    `Fix this error from ${relative(root, g.source)}${g.count > 1 ? ` (seen ${g.count} times this session)` : ''}:`,
    '',
    '```',
    g.sample,
    '```',
    '',
    'Find the cause and fix it. If it comes from code outside this project, say so instead of changing it.',
  ].join('\n')
}

// ---------- reading files ----------

// UTF-8 bytes of a string, so offsets stay in bytes like the file's size.
export function utf8Length(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

// Of text read from a file, the whole lines, and their size in bytes. A last
// line without its newline yet waits for the next read.
export function wholeLines(text: string): { text: string; bytes: number } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { text: '', bytes: 0 }
  const whole = text.slice(0, end + 1)
  return { text: whole, bytes: utf8Length(whole) }
}

// ---------- sources ----------

export type Config = { sources: string[]; minLevel?: Level; tellClaude?: boolean }

export function parseConfigFile(text: string): Partial<Config> {
  const raw = JSON.parse(text) as Record<string, unknown>
  const out: Partial<Config> = {}
  if (Array.isArray(raw.sources)) out.sources = raw.sources.filter((s): s is string => typeof s === 'string')
  if (typeof raw.minLevel === 'string') out.minLevel = parseLevel(raw.minLevel)
  if (typeof raw.tellClaude === 'boolean') out.tellClaude = raw.tellClaude
  return out
}

// The log files to watch for a project, as candidates: each is watched once
// its folder exists, so a debug.log that appears later is still caught.
// `dirExists` answers for folders.
export async function findSources(
  root: string,
  home: string | undefined,
  extra: readonly string[],
  dirExists: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const found: string[] = []
  const add = (path: string) => {
    if (!found.includes(path)) found.push(path)
  }
  // WordPress (wp-content, or Bedrock's web/app) and Laravel, in the project
  // or a folder above it (a theme or plugin inside a site).
  let dir = root
  for (let depth = 0; depth < 8 && dir !== '' && dir !== '/'; depth++) {
    for (const [folder, file] of [['wp-content', 'debug.log'], ['web/app', 'debug.log'], ['storage/logs', 'laravel.log']] as const) {
      if (await dirExists(`${dir}/${folder}`)) add(`${dir}/${folder}/${file}`)
    }
    // A wpdev-style stack: <stack>/sites/<site>, with nginx logs in
    // <stack>/logs/nginx/<site>_error.log.
    const m = /^(.*)\/sites\/([^/]+)$/.exec(dir)
    if (m !== null && (await dirExists(`${m[1]}/logs/nginx`))) add(`${m[1]}/logs/nginx/${m[2]}_error.log`)
    if (found.length > 0) break
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
  for (const path of extra) {
    const expanded = home !== undefined && path.startsWith('~/') ? home + path.slice(1) : path
    add(expanded.startsWith('/') ? expanded : `${root}/${expanded}`)
  }
  return found
}
