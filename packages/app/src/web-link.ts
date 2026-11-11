export function webLink(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^https?:\/\/[^/]/i.test(value) ||
    /[\s\\]/.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (!url.hostname || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export async function openMarkdownLink(
  value: unknown,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  const url = webLink(value)
  if (url === undefined) throw new Error('Only HTTP and HTTPS links can be opened')
  await openExternal(url)
}
