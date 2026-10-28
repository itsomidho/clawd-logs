import { expect, test } from 'claude-code/testing'

import { addEntries, bandLine, findSources, fixText, headline, isDebuggable, localPath, normalize, oneLine, parseEntries, relative, shortenPath, tellText, utf8Length, visible, wholeLines } from '../hooks/logs'

const S = '[22-Oct-2026 14:30:00 UTC] '

test('PHP entries: levels, file and line, stack traces kept with their error', () => {
  const text = [
    `${S}PHP Fatal error:  Uncaught Error: Call to undefined function foo() in /var/www/app/wp-content/themes/t/app/Foo.php:42`,
    'Stack trace:',
    '#0 /var/www/app/wp-includes/class-wp-hook.php(324): bar()',
    '#1 {main}',
    '  thrown in /var/www/app/wp-content/themes/t/app/Foo.php on line 42',
    `${S}PHP Warning:  Undefined array key "x" in /var/www/app/a.php on line 7`,
    `${S}PHP Stack trace:`,
    `${S}PHP   1. {main}() /var/www/app/index.php:0`,
    `${S}PHP Deprecated:  strlen(): Passing null is deprecated in /var/www/app/b.php on line 3`,
    `${S}WordPress database error Duplicate entry 'https://x.com/a' for key 'url' for query INSERT INTO t VALUES ('a') made by include('wp.php'), Foo->save`,
    `${S}my plugin says hello`,
  ].join('\n')
  const entries = parseEntries(text)
  expect(entries.map(e => e.level)).toEqual(['fatal', 'warning', 'notice', 'error', 'notice'])
  expect(entries[0]?.file).toBe('/var/www/app/wp-content/themes/t/app/Foo.php')
  expect(entries[0]?.line).toBe(42)
  expect(entries[0]?.text.includes('#1 {main}')).toBe(true)
  expect(entries[1]?.line).toBe(7)
  expect(entries[1]?.text.includes('1. {main}()')).toBe(true)
})

test('nginx errors: level from the bracket, PHP fatals through FastCGI are fatal', () => {
  const text = [
    '2026/10/10 12:30:41 [error] 49#49: *37 php84 could not be resolved (3: Host not found), client: 172.18.0.1, server: wp-lab.test',
    '2026/10/10 12:30:42 [error] 49#49: *38 FastCGI sent in stderr: "PHP message: PHP Fatal error:  Uncaught TypeError in /var/www/wp-lab/x.php:9"',
    '2026/10/10 12:30:43 [warn] 49#49: an upstream response is buffered to a temporary file',
  ].join('\n')
  expect(parseEntries(text).map(e => e.level)).toEqual(['error', 'fatal', 'warning'])
})

test('repeats group into one: values, URLs and numbers do not split them', () => {
  const a = `${S}WordPress database error Duplicate entry 'https://a.com/1' for key 'url' for query INSERT INTO t VALUES ('1', 2) made by x`
  const b = `${S}WordPress database error Duplicate entry 'https://b.com/2' for key 'url' for query INSERT INTO t VALUES ('3', 4) made by y`
  const c = `${S}PHP Warning:  Undefined variable $a in /w/app/a.php on line 7`
  const d = `${S}PHP Warning:  Undefined variable $a in /w/app/a.php on line 9`
  const { groups, seen } = addEntries([], '/w/app/debug.log', parseEntries([a, b, a, c, d].join('\n')), 1000)
  expect(groups.length).toBe(3)
  const db = groups.find(g => g.level === 'error')
  expect(db?.count).toBe(3)
  expect(db?.message.includes('made by')).toBe(false)
  expect([...seen.values()].sort()).toEqual([1, 1, 3])
  expect(normalize("Duplicate entry 'x' id 42 at https://q.com/z")).toBe("Duplicate entry '…' id <n> at <url>")
})

test('a later batch adds to existing groups and keeps the first sample', () => {
  const line = `${S}PHP Warning:  Undefined variable $a in /w/app/a.php on line 7`
  const first = addEntries([], 'log', parseEntries(line), 1000).groups
  const second = addEntries(first, 'log', parseEntries(`${line}\n${line}`), 2000).groups
  expect(second[0]?.count).toBe(3)
  expect(second[0]?.firstAt).toBe(1000)
  expect(second[0]?.lastAt).toBe(2000)
})

test('levels: the band hides notices by default and leads with the most severe', () => {
  const text = [
    `${S}PHP Notice:  x in /w/app/a.php on line 1`,
    `${S}PHP Warning:  y in /w/app/a.php on line 2`,
    `${S}PHP Fatal error:  z in /w/app/a.php on line 3`,
  ].join('\n')
  const { groups } = addEntries([], 'log', parseEntries(text), 1)
  expect(visible(groups, 'warning').length).toBe(2)
  expect(visible(groups, 'fatal').length).toBe(1)
  expect(headline(visible(groups, 'warning'))?.level).toBe('fatal')
})

test('text: one line per error, paths from the project, a container path matched by name', () => {
  const { groups } = addEntries([], '/home/u/sites/app/wp-content/debug.log',
    parseEntries(`${S}PHP Fatal error:  Uncaught Error: Call to undefined function foo() in /var/www/app/src/Foo.php:42\nStack trace:\n#0 {main}`), 1)
  const g = groups[0]!
  expect(oneLine(g, '/home/u/sites/app')).toBe('Uncaught Error: Call to undefined function foo() · src/Foo.php:42')
  expect(relative('/home/u/sites/app', '/home/u/sites/app/x.php')).toBe('x.php')
  expect(relative('/home/u/sites/app', '/etc/x')).toBe('/etc/x')
  // A container's path is put under the project; another stays as it was.
  expect(localPath('/home/u/sites/app', '/var/www/app/src/Foo.php')).toBe('/home/u/sites/app/src/Foo.php')
  expect(localPath('/home/u/sites/app', '/etc/x')).toBe('/etc/x')
  expect([isDebuggable('a/Foo.php'), isDebuggable('b.py'), isDebuggable('c.mjs'), isDebuggable('d.css'), isDebuggable('debug.log')]).toEqual([true, true, true, false, false])
  const told = tellText([{ group: g, times: 2 }], '/home/u/sites/app')
  expect(told.includes('[Fatal]')).toBe(true)
  expect(told.includes('(×2)')).toBe(true)
  expect(told.includes('wp-content/debug.log')).toBe(true)
  expect(told.includes('#0 {main}')).toBe(true)
  expect(fixText(g, '/home/u/sites/app').includes('```\nPHP Fatal error')).toBe(true)
})

test('a WP-CLI eval fatal points at the phar file once', () => {
  const text = `${S}PHP Fatal error:  Uncaught Error: Call to undefined function x() in phar:///usr/local/bin/wp/vendor/wp-cli/eval-command/src/Eval_Command.php(39) : eval()'d code:1`
  const { groups } = addEntries([], 'log', parseEntries(text), 1)
  expect(groups[0]?.file).toBe('phar:///usr/local/bin/wp/vendor/wp-cli/eval-command/src/Eval_Command.php')
  expect(oneLine(groups[0]!, '/stack/sites/app')).toBe('Uncaught Error: Call to undefined function x() · phar:///usr/local/bin/wp/vendor/wp-cli/eval-command/src/Eval_Command.php:39')
})

test('reading: only whole lines count, offsets in UTF-8 bytes', () => {
  expect(wholeLines('a\nb\npart')).toEqual({ text: 'a\nb\n', bytes: 4 })
  expect(wholeLines('no newline yet')).toEqual({ text: '', bytes: 0 })
  expect(utf8Length('é€😀')).toBe(2 + 3 + 4)
})

test('sources: WordPress in the project or above it, wpdev nginx logs, extra paths', async () => {
  const dirs = new Set(['/stack/sites/app/wp-content', '/stack/logs/nginx'])
  const isDir = async (p: string) => dirs.has(p)
  expect(await findSources('/stack/sites/app', '/home/u', [], isDir)).toEqual([
    '/stack/sites/app/wp-content/debug.log',
    '/stack/logs/nginx/app_error.log',
  ])
  expect(await findSources('/stack/sites/app/wp-content/themes/t', '/home/u', ['logs/x.log', '~/y.log'], isDir)).toEqual([
    '/stack/sites/app/wp-content/debug.log',
    '/stack/logs/nginx/app_error.log',
    '/stack/sites/app/wp-content/themes/t/logs/x.log',
    '/home/u/y.log',
  ])
  expect(await findSources('/elsewhere', undefined, [], isDir)).toEqual([])
})

test('the band line keeps file:line and cuts the message first', () => {
  const root = '/home/u/sites/app'
  const { groups } = addEntries([], 'log', parseEntries(`${S}PHP Fatal error:  Uncaught Error: Call to undefined function some_long_function_name() in /home/u/sites/app/web/app/themes/sage/app/View/Composers/Header.php:42`), 1)
  const g = groups[0]!
  expect(bandLine(g, root, 300)).toBe(oneLine(g, root))
  const line = bandLine(g, root, 80)
  expect(line.length <= 80).toBe(true)
  expect(line.startsWith('Uncaught Error: Call to')).toBe(true)
  expect(line.endsWith(' · web/app/themes/…/Composers/Header.php:42')).toBe(true)
  const tight = bandLine(g, root, 50)
  expect(tight.length <= 50).toBe(true)
  expect(tight.endsWith('…/Header.php:42')).toBe(true)
  expect(shortenPath('/a/b', 10)).toBe('/a/b')
})
