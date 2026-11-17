import { rm } from 'node:fs/promises'
import type { LinearFile, LinearUnfetched } from '@ted/protocol'
import { maxAttachmentBytes } from '../attachments.ts'
import {
  DownloadError,
  type Downloaded,
  type FileStore,
  saveDownload,
  tooLarge,
  withExtension,
} from '../downloads.ts'

export const linearUploadsOrigin = 'https://uploads.linear.app'
export const maxLinearFiles = 20

export type LinearFileStore = FileStore

export interface LinearIssueAttachment {
  url?: unknown
  title?: unknown
}

interface FileRef {
  url: string
  name: string
}

const maxRedirects = 3
const parallel = 4
const urlPattern = /(?:(!?)\[([^\]\n]*)\]\()?(https?:\/\/[^\s<>()[\]"'`]+)/g
const bareUrlPattern = /https?:\/\/[^\s<>()[\]"'`]+/g

export async function fetchLinearFiles(input: {
  key: string
  origins: ReadonlySet<string>
  description: string | undefined
  attachments: readonly LinearIssueAttachment[]
  store: LinearFileStore
  timeoutMs?: number
  totalMs?: number
}): Promise<{ files: LinearFile[]; unfetched: LinearUnfetched[] }> {
  const refs = fileRefs(input.description, input.attachments, input.origins)
  const taken = refs.slice(0, maxLinearFiles)
  const overall = AbortSignal.timeout(input.totalMs ?? 60_000)
  const results: (LinearFile | LinearUnfetched)[] = new Array(taken.length)
  let next = 0
  const worker = async () => {
    while (next < taken.length) {
      const index = next++
      const ref = taken[index]
      if (ref) results[index] = await fetchOne(ref)
    }
  }
  const fetchOne = async (ref: FileRef): Promise<LinearFile | LinearUnfetched> => {
    try {
      const signal = AbortSignal.any([overall, AbortSignal.timeout(input.timeoutMs ?? 30_000)])
      const got = await download(ref.url, input.key, input.origins, input.store.dir, signal)
      const attachment = await input.store
        .save(got.file, withExtension(ref.name, got.mediaType), got.mediaType)
        .finally(() => rm(got.file, { force: true }))
      return { ...attachment, url: ref.url }
    } catch (error) {
      return { name: ref.name, url: ref.url, reason: reasonOf(error) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, taken.length) }, worker))
  const files = results.filter((r): r is LinearFile => 'hash' in r)
  const unfetched = [
    ...results.filter((r): r is LinearUnfetched => 'reason' in r),
    ...refs.slice(maxLinearFiles).map((ref) => ({
      name: ref.name,
      url: ref.url,
      reason: `Ted takes at most ${maxLinearFiles} files from an issue`,
    })),
  ]
  return { files, unfetched }
}

export function linkedFilesRewritten(
  text: string,
  files: readonly LinearFile[],
  to: (file: LinearFile) => string,
): string {
  const byUrl = new Map(files.map((file) => [file.url, file]))
  return text.replace(bareUrlPattern, (url) => {
    const file = byUrl.get(url)
    return file ? to(file) : url
  })
}

function fileRefs(
  description: string | undefined,
  attachments: readonly LinearIssueAttachment[],
  origins: ReadonlySet<string>,
): FileRef[] {
  const refs = new Map<string, FileRef>()
  const add = (url: string, name: string) => {
    if (refs.has(url) || !URL.canParse(url) || !origins.has(new URL(url).origin)) return
    refs.set(url, { url, name: name.trim() || 'file' })
  }
  for (const match of (description ?? '').matchAll(urlPattern)) {
    const [, bang, text, url = ''] = match
    add(url, text ?? (bang === '!' ? 'image' : ''))
  }
  for (const attachment of attachments) {
    if (typeof attachment.url !== 'string') continue
    add(attachment.url, typeof attachment.title === 'string' ? attachment.title : '')
  }
  return [...refs.values()]
}

async function download(
  url: string,
  key: string,
  origins: ReadonlySet<string>,
  dir: string,
  signal: AbortSignal,
): Promise<Downloaded> {
  let target = new URL(url)
  for (let hop = 0; ; hop++) {
    if (!origins.has(target.origin)) {
      throw new DownloadError('Linear redirected the download to another host')
    }
    let response: Response
    try {
      response = await fetch(target, {
        headers: { authorization: key },
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      throw new DownloadError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'the download timed out'
          : 'Ted couldn’t reach Linear',
      )
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (location === null || !URL.canParse(location, target.href)) {
        throw new DownloadError(`Linear answered ${response.status}`)
      }
      if (hop >= maxRedirects) throw new DownloadError('Linear redirected the download too often')
      target = new URL(location, target)
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new DownloadError(`Linear answered ${response.status}`)
    }
    if (Number(response.headers.get('content-length')) > maxAttachmentBytes) {
      await response.body.cancel()
      throw tooLarge()
    }
    return saveDownload(response, dir, 'linear')
  }
}

function reasonOf(error: unknown): string {
  return error instanceof DownloadError ? error.message : 'Ted couldn’t save the file'
}
