import { rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import type { LinearFile, LinearUnfetched } from '@ted/protocol'
import { maxAttachmentBytes } from '../attachments.ts'
import {
  DownloadError,
  type FileStore,
  saveDownload,
  tooLarge,
  withExtension,
} from '../downloads.ts'
import type { AsanaAttachment } from './tree.ts'

const parallel = 4

export async function fetchAsanaFiles(input: {
  attachments: readonly AsanaAttachment[]
  store: FileStore
  allowLoopback: boolean
  timeoutMs?: number
  totalMs?: number
}): Promise<{ files: LinearFile[]; unfetched: LinearUnfetched[] }> {
  const overall = AbortSignal.timeout(input.totalMs ?? 120_000)
  const results: (LinearFile | LinearUnfetched)[] = new Array(input.attachments.length)
  let next = 0
  const worker = async () => {
    while (next < input.attachments.length) {
      const index = next++
      const attachment = input.attachments[index]
      if (!attachment) continue
      try {
        const signal = AbortSignal.any([overall, AbortSignal.timeout(input.timeoutMs ?? 30_000)])
        const got = await download(attachment.downloadUrl ?? '', input, signal)
        const saved = await input.store
          .save(got.file, withExtension(attachment.name, got.mediaType), got.mediaType)
          .finally(() => rm(got.file, { force: true }))
        results[index] = { ...saved, url: attachment.viewUrl }
      } catch (error) {
        results[index] = {
          name: attachment.name,
          url: attachment.viewUrl,
          reason: error instanceof DownloadError ? error.message : 'Ted couldn’t save the file',
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, input.attachments.length) }, worker))
  return {
    files: results.filter((r): r is LinearFile => r !== undefined && 'hash' in r),
    unfetched: results.filter((r): r is LinearUnfetched => r !== undefined && 'reason' in r),
  }
}

export function downloadTarget(url: string, allowLoopback: boolean): URL {
  if (!URL.canParse(url)) throw new DownloadError('Asana gave no usable download link')
  const target = new URL(url)
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === '127.0.0.1' && target.protocol === 'http:'
  if (target.username || target.password)
    throw new DownloadError('Asana gave no usable download link')
  if (loopback && allowLoopback) return target
  if (
    target.protocol !== 'https:' ||
    isIP(host) !== 0 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    !host.includes('.')
  )
    throw new DownloadError('Asana gave no usable download link')
  return target
}

async function download(
  url: string,
  input: { store: FileStore; allowLoopback: boolean },
  signal: AbortSignal,
) {
  const target = downloadTarget(url, input.allowLoopback)
  let response: Response
  try {
    response = await fetch(target, { redirect: 'error', signal, credentials: 'omit' })
  } catch (error) {
    throw new DownloadError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'the download timed out'
        : 'Ted couldn’t download it',
    )
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new DownloadError(`the download answered ${response.status}`)
  }
  if (Number(response.headers.get('content-length')) > maxAttachmentBytes) {
    await response.body.cancel()
    throw tooLarge()
  }
  return saveDownload(response, input.store.dir, 'asana')
}
