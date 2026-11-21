export const phoneFilePartBytes = 24_576
export const phoneFileMaxBytes = 10 * 1024 * 1024
export const phoneFilePartsMax = Math.ceil(phoneFileMaxBytes / phoneFilePartBytes)
export const phoneFilesMax = 10
export const phoneFileNameMax = 255
export const phoneMediaTypeMax = 255
export const phoneStagedBytesMax = 100 * 1024 * 1024
export const phoneUploadLifetimeMs = 60 * 60_000

export const phoneFileMissing = 'A file didn’t reach your Mac. Send again.'
export const phoneFileTooBig = 'Files from your phone must be 10 MB or less.'
export const phoneFilesWaiting =
  'Too many files are waiting on your Mac. Send again in a little while.'

export function phoneFileParts(size: number): number {
  return Math.ceil(size / phoneFilePartBytes)
}
