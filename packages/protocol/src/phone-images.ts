import { type Json, ParseError, reader, type Untyped } from './parse.ts'

export const phoneImageIdMax = 200
export const phoneImageCaptionMax = 200
export const phoneImagePartBytes = 28_000
export const phoneImageWidthMax = 1170

export interface PhoneImage {
  image: string
  caption?: string
}

export interface PhoneImageBody {
  mediaType: string
  parts: number
  part: number
  data: string
}

const read = reader()

export function parsePhoneImage(value: Json | undefined, field = 'image'): PhoneImage {
  const object = read.object(value, field)
  const caption = read.optional(object, 'caption', read.string)
  return {
    image: read.string(object, 'image'),
    ...(caption !== undefined && { caption }),
  }
}

export function parsePhoneImageBody(value: Untyped): PhoneImageBody {
  const object = read.object(value, 'body')
  const parts = read.integer(object, 'parts')
  const part = read.integer(object, 'part')
  if (parts < 1) throw new ParseError('parts', 'parts must be at least 1')
  if (part < 0 || part >= parts) throw new ParseError('part', 'part must be from 0 to parts − 1')
  return {
    mediaType: read.string(object, 'mediaType'),
    parts,
    part,
    data: read.string(object, 'data'),
  }
}
