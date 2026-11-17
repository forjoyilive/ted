import { expect, test } from 'vitest'
import { reposSection } from '../src/tasks/other-factories.ts'

test('the Repos section is read from a Factory’s notes up to the next heading of its level', () => {
  const notes = [
    '# Website',
    'Intro.',
    '## Repos',
    '',
    'One repo, `acme/site`.',
    '### Layout',
    '- `src/pages`',
    '## Where things live',
    'Linear.',
  ].join('\n')
  expect(reposSection(notes)).toBe('One repo, `acme/site`.\n### Layout\n- `src/pages`')
  expect(reposSection('# Repos\nacme/app')).toBe('acme/app')
  expect(reposSection('## Notes\nNothing here')).toBeUndefined()
  expect(reposSection('## Repos\n\n## Next')).toBeUndefined()
  expect(reposSection(undefined)).toBeUndefined()
  expect(reposSection(`## Repos\n${'x'.repeat(3000)}`)?.length).toBe(2000)
})
