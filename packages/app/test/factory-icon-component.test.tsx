// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import { FactoryColorsProvider, FactoryName } from '../src/renderer/components/FactoryIcon.tsx'
import { factory } from './support/fixtures.ts'

test('a Factory’s icon adds no text beside its name, and an uncolored letter mark takes its automatic color', () => {
  const factories = [
    factory({ id: 'f1', name: 'Notebook', icon: { kind: 'letter', color: 'blue' } }),
    factory({ id: 'f2', name: 'Billing', icon: { kind: 'emoji', emoji: '🧾' } }),
    factory({ id: 'f3', name: 'Marketing site' }),
  ]
  const { container } = render(
    <FactoryColorsProvider factories={factories}>
      <p>
        <FactoryName factories={factories} factoryId="f1" />
      </p>
      <p>
        <FactoryName factories={factories} factoryId="f2" />
      </p>
      <p>
        <FactoryName factories={factories} factoryId="f3" />
      </p>
    </FactoryColorsProvider>,
  )
  const lines = [...container.querySelectorAll('p')]
  expect(lines.map((line) => line.textContent)).toEqual(['Notebook', 'Billing', 'Marketing site'])
  const marks = lines.map((line) => line.querySelector('[data-glyph]'))
  expect(marks.map((mark) => mark?.getAttribute('data-glyph'))).toEqual(['N', '🧾', 'M'])
  expect(marks[2]?.getAttribute('style')).toContain('var(--factory-icon-teal-fg)')
})
