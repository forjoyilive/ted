import path from 'node:path'

export interface NodeCommand {
  command: string
  args: string[]
}

export function nodeEntry(
  file: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): NodeCommand {
  const { APPIMAGE: appImage, APPDIR: appDir } = env
  if (appImage && appDir && file.startsWith(`${appDir}${path.sep}`)) {
    return {
      command: appImage,
      args: ['-e', appImageLoader(path.relative(appDir, file)), '--', ...args],
    }
  }
  return { command: process.execPath, args: [file, ...args] }
}

function appImageLoader(relative: string): string {
  return [
    `const file = require('node:path').join(process.env.APPDIR, ${JSON.stringify(relative)})`,
    'process.argv.splice(1, 0, file)',
    "import(require('node:url').pathToFileURL(file).href).catch((error) => { console.error(error); process.exit(1) })",
  ].join('\n')
}

export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

export function shellScript(entry: NodeCommand, env: Record<string, string> = {}): string {
  const exports = Object.entries(env).map(
    ([name, value]) => `export ${name}=${shellQuote(value)}\n`,
  )
  const words = [entry.command, ...entry.args].map(shellQuote).join(' ')
  return `#!/bin/sh\n${exports.join('')}exec ${words} "$@"\n`
}
