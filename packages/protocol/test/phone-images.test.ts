import { expect, test } from 'vitest'
import {
  type PhoneImageBody,
  parsePhoneImage,
  parsePhoneImageBody,
  phoneImageIdMax,
} from '../src/phone-images.ts'
import { parsePhoneRequest, toBase64Url } from '../src/phones.ts'

const header = { protocol: 3, id: toBase64Url(new Uint8Array(16)), at: 1, type: 'request' }

test('the image route takes an image ID of 1 to 200 characters and a whole part from 0', () => {
  const asked = { ...header, route: 'image', image: 'aW1n', part: 0 }
  expect(parsePhoneRequest(asked)).toEqual(asked)
  const last = { ...asked, image: 'x'.repeat(phoneImageIdMax), part: 4 }
  expect(parsePhoneRequest(last)).toEqual(last)
  for (const [field, value] of [
    ['image', ''],
    ['image', 'x'.repeat(phoneImageIdMax + 1)],
    ['image', 3],
    ['image', undefined],
    ['part', -1],
    ['part', 1.5],
    ['part', '0'],
    ['part', undefined],
  ] as const) {
    expect(() => parsePhoneRequest({ ...asked, [field]: value }), `${field} ${value}`).toThrow(
      field,
    )
  }
})

test('an image reply has its media type, part count, part and data', () => {
  const body: PhoneImageBody = { mediaType: 'image/jpeg', parts: 3, part: 2, data: 'AAEC' }
  expect(parsePhoneImageBody(body)).toEqual(body)
  for (const [field, value] of [
    ['mediaType', 1],
    ['parts', 0],
    ['parts', 1.5],
    ['part', 3],
    ['part', -1],
    ['data', undefined],
  ] as const) {
    expect(() => parsePhoneImageBody({ ...body, [field]: value }), `${field} ${value}`).toThrow()
  }
  expect(parsePhoneImage({ image: 'aW1n' })).toEqual({ image: 'aW1n' })
  expect(parsePhoneImage({ image: 'aW1n', caption: 'a.png' })).toEqual({
    image: 'aW1n',
    caption: 'a.png',
  })
  expect(() => parsePhoneImage({ caption: 'a.png' })).toThrow(/image/)
})
