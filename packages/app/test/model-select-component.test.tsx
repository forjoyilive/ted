// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ModelSelect } from '../src/renderer/components/ModelSelect.tsx'
import { bridge, user } from './support/component.ts'

const shown = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent)

test('with Pi chosen, the picker lists Pi’s models, refreshes when opened, keeps a saved model Pi no longer lists, and falls back to Other… alone', async () => {
  let listed: string[] | undefined = ['ollama/gemma4:12b', 'zai/glm-5.3']
  const api = bridge({
    agentModels: () => {
      if (listed === undefined) throw new Error('Pi isn’t installed')
      return { models: listed }
    },
  })
  render(<ModelSelect agent="pi" value="zai/glm-5.2" onChange={vi.fn()} aria-label="Model" />)
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' })
  await waitFor(() =>
    expect(shown(select)).toEqual([
      'Default model',
      'ollama/gemma4:12b',
      'zai/glm-5.3',
      'zai/glm-5.2',
      'Other…',
    ]),
  )
  expect(api.request).toHaveBeenCalledWith('agentModels', 'pi')

  listed = ['ollama/gemma4:12b']
  await user().click(select)
  await waitFor(() =>
    expect(shown(select)).toEqual(['Default model', 'ollama/gemma4:12b', 'zai/glm-5.2', 'Other…']),
  )

  listed = undefined
  await user().click(select)
  await waitFor(() => expect(shown(select)).toEqual(['Default model', 'zai/glm-5.2', 'Other…']))
})

test('an open picker follows Pi’s refreshed list and picks the model it shows', async () => {
  let listed = ['ollama/gemma4:12b', 'zai/glm-5.3']
  bridge({ agentModels: () => ({ models: listed }) })
  const onChange = vi.fn()
  render(<ModelSelect agent="pi" value="" onChange={onChange} aria-label="Model" />)
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' })
  await waitFor(() => expect(shown(select)).toContain('ollama/gemma4:12b'))

  listed = ['zai/glm-5.3']
  await user().click(select)
  const popup = screen.getByRole('listbox', { name: 'Model' })
  await waitFor(() =>
    expect(
      within(popup)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Default model', 'zai/glm-5.3', 'Other…']),
  )
  await user().click(within(popup).getByRole('option', { name: 'zai/glm-5.3' }))
  expect(onChange).toHaveBeenCalledWith('zai/glm-5.3')
})

test('the picker doesn’t ask Pi for models when another Provider is chosen', () => {
  const api = bridge({})
  render(<ModelSelect agent="claude" value="" onChange={vi.fn()} aria-label="Model" />)
  expect(shown(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }))).toEqual([
    'Default model',
    'fable',
    'opus',
    'sonnet',
    'haiku',
    'Other…',
  ])
  expect(api.request).not.toHaveBeenCalledWith('agentModels', 'pi')
})
