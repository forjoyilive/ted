import { open, stat } from 'node:fs/promises'

export interface ReadyRead {
  from: number
  floor: number
}

const readyLine = 'TED_APP_READY'
const readyPattern = /(?:^|\n)[ \t]*TED_APP_READY[ \t]*\r?\n/
const readyChunkBytes = 1024 * 1024

export async function logSize(file: string): Promise<number> {
  return (await stat(file).catch(() => undefined))?.size ?? 0
}

export const readyFromLaunch = (offset: number): ReadyRead => ({ from: offset, floor: offset })

export async function readyLineSince(
  file: string,
  read: ReadyRead,
): Promise<{ ready: boolean; read: ReadyRead }> {
  const size = await logSize(file)
  const rotated = read.from > size
  const floor = rotated ? 0 : read.floor
  const from = rotated ? 0 : read.from
  if (size === from) return { ready: false, read: { from, floor } }
  const start = Math.max(floor, from - readyLine.length - 2)
  const length = Math.min(size - start, readyChunkBytes)
  const handle = await open(file, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, start)
    return {
      ready: readyPattern.test(buffer.subarray(0, bytesRead).toString('utf8')),
      read: { from: start + bytesRead, floor },
    }
  } finally {
    await handle.close()
  }
}
