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

export const maxGitHubFiles = 20

const maxRedirects = 3
const parallel = 4
const linkPattern = /(?:(!?)\[([^\]\n]*)\]\()?(https?:\/\/[^\s<>()[\]"'`]+)/g
const htmlLinkPattern = /(?:src|href)="(https?:\/\/[^"]+)"/g
const htmlImgPattern = /<img\b[^>]*>/g

const uploadHosts = new Set([
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-production-user-asset-6210df.s3.amazonaws.com',
  'github-production-repository-file-5c1aeb.s3.amazonaws.com',
])

export interface GitHubUploads {
  origins?: ReadonlySet<string>
}

interface FileRef {
  url: string
  download: string
  name: string
}

export function isGitHubUpload(url: string, uploads: GitHubUploads = {}): boolean {
  if (!URL.canParse(url)) return false
  const target = new URL(url)
  if (target.username || target.password) return false
  if (uploads.origins) return uploads.origins.has(target.origin)
  if (target.protocol !== 'https:' || target.port !== '') return false
  const host = target.hostname.toLowerCase()
  if (uploadHosts.has(host)) return true
  return (
    host === 'github.com' &&
    (/^\/user-attachments\/(assets|files)\//.test(target.pathname) ||
      /^\/[^/]+\/[^/]+\/assets\/\d+\//.test(target.pathname))
  )
}

export function uploadRefs(
  posts: readonly { body: string; html: string }[],
  uploads: GitHubUploads = {},
): FileRef[] {
  const refs = new Map<string, FileRef>()
  for (const post of posts) {
    const signed = htmlLinks(post.html).filter((url) => isGitHubUpload(url, uploads))
    for (const match of post.body.matchAll(linkPattern)) {
      const [, bang, text, url = ''] = match
      if (refs.has(url) || !isGitHubUpload(url, uploads)) continue
      const id = assetId(url)
      const download =
        (id !== undefined &&
          signed.find((link) => link !== url && link.includes(id) && isSigned(link))) ||
        url
      refs.set(url, { url, download, name: fileName(text, url, bang === '!') })
    }
  }
  return [...refs.values()]
}

function htmlLinks(html: string): string[] {
  const links = [...html.matchAll(htmlLinkPattern)].map(([, url = '']) => url)
  const imgs = [...html.matchAll(htmlImgPattern)].flatMap(([tag]) =>
    [...tag.matchAll(/data-canonical-src="(https?:\/\/[^"]+)"/g)].map(([, url = '']) => url),
  )
  return [...links, ...imgs].map(unescapeHtml)
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function isSigned(url: string): boolean {
  const { searchParams } = new URL(url)
  return searchParams.has('jwt') || searchParams.has('X-Amz-Signature')
}

function assetId(url: string): string | undefined {
  const segments = new URL(url).pathname.split('/').filter((part) => part !== '')
  const files = segments.indexOf('files')
  const id =
    files >= 0 && segments[0] === 'user-attachments' ? segments[files + 1] : segments.at(-1)
  const bare = id?.replace(/\.[A-Za-z0-9]+$/, '')
  return bare !== undefined && bare.length >= 6 ? bare : undefined
}

function fileName(text: string | undefined, url: string, image: boolean): string {
  const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
  const raw = text?.trim() || (/\.[A-Za-z0-9]+$/.test(fromUrl) ? fromUrl : '')
  const safe = raw
    .replace(/[^\w .()-]+/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 100)
  return safe || (image ? 'image' : 'file')
}

export async function fetchGitHubFiles(input: {
  refs: readonly FileRef[]
  store: FileStore
  uploads?: GitHubUploads
  timeoutMs?: number
  totalMs?: number
}): Promise<{ files: LinearFile[]; unfetched: LinearUnfetched[] }> {
  const taken = input.refs.slice(0, maxGitHubFiles)
  const overall = AbortSignal.timeout(input.totalMs ?? 60_000)
  const results: (LinearFile | LinearUnfetched)[] = new Array(taken.length)
  let next = 0
  const fetchOne = async (ref: FileRef): Promise<LinearFile | LinearUnfetched> => {
    try {
      const signal = AbortSignal.any([overall, AbortSignal.timeout(input.timeoutMs ?? 30_000)])
      const got = await download(ref.download, input.uploads ?? {}, input.store.dir, signal)
      const saved = await input.store
        .save(got.file, withExtension(ref.name, got.mediaType), got.mediaType)
        .finally(() => rm(got.file, { force: true }))
      return { ...saved, url: ref.url }
    } catch (error) {
      return {
        name: ref.name,
        url: ref.url,
        reason: error instanceof DownloadError ? error.message : 'Ted couldn’t save the file',
      }
    }
  }
  const worker = async () => {
    while (next < taken.length) {
      const index = next++
      const ref = taken[index]
      if (ref) results[index] = await fetchOne(ref)
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, taken.length) }, worker))
  return {
    files: results.filter((r): r is LinearFile => r !== undefined && 'hash' in r),
    unfetched: [
      ...results.filter((r): r is LinearUnfetched => r !== undefined && 'reason' in r),
      ...input.refs.slice(maxGitHubFiles).map((ref) => ({
        name: ref.name,
        url: ref.url,
        reason: `Ted takes at most ${maxGitHubFiles} files from an issue`,
      })),
    ],
  }
}

async function download(
  url: string,
  uploads: GitHubUploads,
  dir: string,
  signal: AbortSignal,
): Promise<Downloaded> {
  let target = new URL(url)
  for (let hop = 0; ; hop++) {
    if (!isGitHubUpload(target.href, uploads)) {
      throw new DownloadError('GitHub sent the download to a host Ted doesn’t download from')
    }
    let response: Response
    try {
      response = await fetch(target, { redirect: 'manual', credentials: 'omit', signal })
    } catch (error) {
      throw new DownloadError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'the download timed out'
          : 'Ted couldn’t reach GitHub',
      )
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (location === null || !URL.canParse(location, target.href)) {
        throw new DownloadError(`GitHub answered ${response.status}`)
      }
      if (hop >= maxRedirects) throw new DownloadError('GitHub redirected the download too often')
      target = new URL(location, target)
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new DownloadError(
        response.status === 404 || response.status === 403
          ? 'GitHub didn’t give Ted a link it could download without signing in'
          : `GitHub answered ${response.status}`,
      )
    }
    if (Number(response.headers.get('content-length')) > maxAttachmentBytes) {
      await response.body.cancel()
      throw tooLarge()
    }
    return saveDownload(response, dir, 'github')
  }
}
