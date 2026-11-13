import { describe, expect, test } from 'vitest'
import { titleFromText } from '../src/tasks/task-title.ts'

describe('titleFromText', () => {
  test('takes the first non-blank line as the title and leaves the rest', () => {
    expect(titleFromText('\n  Fix the login button \n\nIt overlaps the footer.\n')).toEqual({
      title: 'Fix the login button',
      description: 'It overlaps the footer.',
    })
  })

  test('a one-line text leaves an empty description', () => {
    expect(titleFromText(' Fix the login button ')).toEqual({
      title: 'Fix the login button',
      description: '',
    })
  })

  test('blank text gives no title', () => {
    expect(titleFromText(' \n ')).toEqual({ title: '', description: '' })
  })
})
