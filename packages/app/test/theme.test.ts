import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { factoryIconColors } from '@ted/protocol/factory-icon'
import { describe, expect, test } from 'vitest'

const rendererDir = fileURLToPath(new URL('../src/renderer', import.meta.url))
const tokensPath = path.join(rendererDir, 'styles/tokens.css')
const colour =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(|(?<![\w-])(?:white|black)(?![\w-])/i

async function sources(): Promise<{ file: string; text: string }[]> {
  const entries = await readdir(rendererDir, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && /\.(css|tsx?|html)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, 'utf8') })))
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

async function tokens(): Promise<Map<string, string>> {
  const text = await readFile(tokensPath, 'utf8')
  return new Map(
    [...text.matchAll(/^\s*(--[a-z0-9-]+):\s*(.+);$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']),
  )
}

describe('theme tokens', () => {
  test('no colour is written outside the token file', async () => {
    const offenders = (await sources())
      .filter(({ file }) => file !== tokensPath)
      .flatMap(({ file, text }) =>
        text
          .split('\n')
          .map((line, i) => ({ line, at: `${path.relative(rendererDir, file)}:${i + 1}` }))
          .filter(({ line }) => colour.test(line.replace(/var\(--[a-z0-9-]+\)/g, '')))
          .map(({ at, line }) => `${at} ${line.trim()}`),
      )

    expect(offenders).toEqual([])
  })

  test('every colour token has a light and a dark value', async () => {
    const colours = [...(await tokens())].filter(([, value]) => colour.test(value))

    expect(colours.length).toBeGreaterThan(80)
    for (const [name, value] of colours) {
      expect(value, name).toMatch(/^light-dark\(#[0-9a-f]{6,8}, #[0-9a-f]{6,8}\)$/)
    }
  })

  test('every token the renderer uses is defined', async () => {
    const defined = await tokens()
    const used = new Set(
      (await sources()).flatMap(({ text }) =>
        [...text.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1] ?? ''),
      ),
    )

    expect([...used].filter((name) => !defined.has(name))).toEqual([])
  })

  test('text, icons and control borders meet WCAG AA contrast in light and dark mode', async () => {
    const defined = await tokens()
    const surfaces = [
      '--surface-app',
      '--surface-sidebar',
      '--surface-pane',
      '--surface-card',
      '--surface-raised',
      '--surface-column',
      '--surface-inset',
      '--surface-hover',
      '--surface-selected',
      '--surface-neutral',
    ]
    const onSurfaces = (names: string[], minimum: number) =>
      names.flatMap((name) => surfaces.map((surface) => [name, surface, minimum] as const))
    const pairs: (readonly [foreground: string, background: string, minimum: number])[] = [
      ...onSurfaces(
        [
          '--text-primary',
          '--text-secondary',
          '--text-tertiary',
          '--text-caption',
          '--text-muted',
          '--accent-text',
          '--accent-link',
          '--status-testing-fg',
          '--status-working-fg',
          '--status-waiting-fg',
          '--status-warning-text',
          '--status-failed-fg',
          '--status-destructive-text',
          '--status-neutral-fg',
          '--status-success-fg',
          '--diff-added-count',
          '--diff-removed-count',
        ],
        4.5,
      ),
      ...onSurfaces(
        [
          '--text-faint',
          '--border-control',
          '--focus-ring',
          '--event-neutral',
          '--priority-none',
          '--agent-ring-paused',
          '--agent-ring-idle',
        ],
        3,
      ),
      ['--status-testing-fg', '--status-testing-bg', 4.5],
      ['--status-working-fg', '--status-working-bg', 4.5],
      ['--status-waiting-fg', '--status-waiting-bg', 4.5],
      ['--status-warning-text', '--status-waiting-bg', 4.5],
      ['--status-failed-fg', '--status-failed-bg', 4.5],
      ['--status-neutral-fg', '--status-neutral-bg', 4.5],
      ['--status-success-fg', '--status-success-bg', 4.5],
      ['--accent-text', '--accent-subtle', 4.5],
      ['--diff-added-count', '--diff-added-line', 4.5],
      ['--diff-removed-count', '--diff-removed-line', 4.5],
      ['--text-on-accent', '--accent-default', 4.5],
      ['--text-on-accent-muted', '--accent-default', 4.5],
      ['--text-on-accent', '--status-destructive', 4.5],
      ['--text-on-inverse', '--surface-inverse', 4.5],
      ['--text-on-inverse-muted', '--surface-inverse', 4.5],
      ['--tooltip-fg', '--tooltip-bg', 4.5],
      ['--tooltip-fg-muted', '--tooltip-bg', 4.5],
      ['--control-selected-fg', '--control-selected-bg', 4.5],
      ['--text-primary', '--control-segment-selected', 4.5],
      ['--text-primary', '--find-match', 4.5],
      ['--text-primary', '--find-current', 4.5],
      ['--terminal-fg', '--terminal-bg', 4.5],
      ['--terminal-muted', '--terminal-bg', 4.5],
      ...factoryIconColors.flatMap((color) => [
        [`--factory-icon-${color}-fg`, `--factory-icon-${color}-bg`, 4.5] as const,
        [`--factory-icon-${color}-fg`, '--surface-raised', 3] as const,
      ]),
    ]
    const themes = (name: string): [light: string, dark: string] => {
      const found = defined.get(name)?.match(/^light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)$/)
      if (!found?.[1] || !found[2]) throw new Error(`${name} is not an opaque light-dark() colour`)
      return [found[1], found[2]]
    }

    const failures = pairs.flatMap(([foreground, background, minimum]) =>
      (['light', 'dark'] as const).flatMap((theme, i) => {
        const ratio = contrast(themes(foreground)[i] ?? '', themes(background)[i] ?? '')
        return ratio < minimum
          ? [`${theme} ${foreground} on ${background}: ${ratio.toFixed(2)} < ${minimum}`]
          : []
      }),
    )

    expect(failures).toEqual([])
  })

  test('status colours, diff green and red, and the agent marks are tokens', async () => {
    const defined = await tokens()

    for (const name of [
      '--status-working-fg',
      '--status-waiting-fg',
      '--status-failed-fg',
      '--status-neutral-fg',
      '--diff-added-count',
      '--diff-removed-count',
      '--agent-mark',
      '--agent-mark-strong',
    ]) {
      expect(defined.has(name), name).toBe(true)
    }
  })
})

describe('disabled and control styles', () => {
  test('no disabled state fades a control with opacity', async () => {
    const faded = (await sources())
      .filter(({ file }) => file.endsWith('.css'))
      .flatMap(({ file, text }) =>
        [...text.matchAll(/([^{}]*)\{([^}]*)\}/g)].flatMap((m) =>
          /disabled/.test(m[1] ?? '') && /(^|\n)\s*opacity:/.test(m[2] ?? '')
            ? [`${path.relative(rendererDir, file)} ${(m[1] ?? '').trim()}`]
            : [],
        ),
      )

    expect(faded).toEqual([])
  })

  test('inputs, selects, buttons and switches are outlined with the control border', async () => {
    const controls: [file: string, selector: string][] = [
      ['settings/editor.module.css', '.field'],
      ['settings/linear.module.css', '.field'],
      ['settings/settings.module.css', '.button'],
      ['settings/settings.module.css', '.select'],
      ['settings/settings.module.css', '.stepper'],
      ['settings/settings.module.css', '.switch'],
      ['components/SettingsSearch.module.css', '.input'],
      ['components/Sidebar.module.css', '.search'],
      ['views/Inbox.module.css', '.chip'],
      ['views/FactorySettings.module.css', '.timeoutInput'],
      ['views/FactorySettingsSections.module.css', '.switch'],
      ['views/Automations.module.css', '.switch'],
      ['views/TaskList.module.css', '.search'],
      ['views/DataScreen.module.css', '.secondary'],
    ]

    for (const [file, selector] of controls) {
      const text = await readFile(path.join(rendererDir, file), 'utf8')
      const bodies = [...text.matchAll(/(?:^|\n)([^{}\n]+) \{([^}]*)\}/g)].flatMap((m) =>
        m[1] === selector ? [m[2] ?? ''] : [],
      )
      expect(
        bodies.some((body) => body.includes('var(--border-control)')),
        `${file} ${selector}`,
      ).toBe(true)
    }
  })
})

describe('button heights', () => {
  const regular = 'var(--button-height)'
  const small = 'var(--button-height-small)'

  async function rule(file: string, name: string): Promise<string> {
    const text = await readFile(path.join(rendererDir, file), 'utf8')
    const found = text.match(new RegExp(`(?:^|\\n)\\.${name}(?:,\\n\\.[a-zA-Z]+)* \\{([^}]*)\\}`))
    return found?.[1] ?? ''
  }

  test('the shared Button has two fixed heights', async () => {
    const defined = await tokens()
    expect(defined.get('--button-height')).toBe('calc(28px * var(--text-scale))')
    expect(defined.get('--button-height-small')).toBe('calc(24px * var(--text-scale))')

    expect(await rule('components/Button.module.css', 'regular')).toContain(`  height: ${regular};`)
    expect(await rule('components/Button.module.css', 'small')).toContain(`  height: ${small};`)
  })

  test('hand-made buttons take their height from the same tokens', async () => {
    const buttons: [file: string, name: string, height: string, grows?: 'grows'][] = [
      ['components/BannerStack.module.css', 'action', regular],
      ['views/TaskLeadField.module.css', 'button', regular, 'grows'],
      ['views/FactorySettings.module.css', 'dangerButton', regular],
      ['settings/settings.module.css', 'button', regular],
      ['views/DataScreen.module.css', 'primary', regular],
      ['components/TaskActions.module.css', 'more', small],
      ['components/DiffViews.module.css', 'step', small],
      ['views/Board.module.css', 'start', small],
      ['components/RequestJumpBar.module.css', 'jump', small],
      ['components/LineComments.module.css', 'chip', small],
      ['views/Inbox.module.css', 'chip', small, 'grows'],
      ['views/Inbox.module.css', 'snooze', small],
      ['components/Markdown.module.css', 'copy', small],
      ['components/FactoryIconPicker.module.css', 'button', regular],
    ]

    for (const [file, name, height, grows] of buttons) {
      const property = grows ? 'min-height' : 'height'
      expect(await rule(file, name), `${file} .${name}`).toContain(`\n  ${property}: ${height};`)
    }
  })
})

describe('text boxes', () => {
  test('every text box grows with its text through the shared rule', async () => {
    const outside = ['WorkerWindow.tsx']
    const boxes = (await sources())
      .filter(({ file }) => file.endsWith('.tsx') && !outside.includes(path.basename(file)))
      .flatMap(({ file, text }) =>
        [...text.matchAll(/<textarea\b[\s\S]*?\/>/g)].map((m) => ({ file, tag: m[0] })),
      )
    expect(boxes.length).toBeGreaterThan(15)
    for (const { file, tag } of boxes) {
      expect(tag, path.relative(rendererDir, file)).toContain('grow.text')
      expect(tag, path.relative(rendererDir, file)).not.toMatch(/\brows=/)
    }
    const rule = await readFile(path.join(rendererDir, 'components/TextGrow.module.css'), 'utf8')
    expect(rule).toContain('field-sizing: content;')
    expect(rule).toContain('max-height: var(--text-grow-max, 50vh);')
  })

  test('each text box starts at least as tall as the rows it showed before', async () => {
    const boxes: [file: string, name: string, rows: number][] = [
      ['components/LineComments.module.css', 'box', 2],
      ['components/ArchiveDialogs.module.css', 'text', 2],
      ['components/FailureRepairForm.module.css', 'description', 2],
      ['components/RoundCard.module.css', 'text', 2],
      ['components/ProposalCard.module.css', 'box', 2],
      ['components/CommentBox.module.css', 'box', 2],
      ['components/RequestCard.module.css', 'box', 2],
      ['components/RunChat.module.css', 'box', 2],
      ['views/Automations.module.css', 'answer', 2],
      ['views/PlanChat.module.css', 'box', 2],
      ['views/NewTaskDialog.module.css', 'description', 3],
      ['views/NewTaskDialog.module.css', 'editDescription', 6],
      ['views/AutomationDialog.module.css', 'prompt', 6],
      ['views/AutomationDialog.module.css', 'requestText', 3],
      ['views/AutomationDialog.module.css', 'suggestionText', 9],
      ['views/FactorySettingsSections.module.css', 'cleanupText', 3],
      ['views/FactorySettingsSections.module.css', 'fileText', 8],
      ['views/FactorySettingsSections.module.css', 'notesText', 12],
    ]
    for (const [file, name, rows] of boxes) {
      const text = await readFile(path.join(rendererDir, file), 'utf8')
      const minimums = [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter((m) => (m[1] ?? '').split(',').some((s) => s.trim() === `.${name}`))
        .flatMap((m) => [...(m[2] ?? '').matchAll(/min-height:\s*([^;]+);/g)].map((h) => h[1]))
      expect(minimums.at(-1), `${file} .${name}`).toContain(`calc(${rows}lh + `)
    }
  })
})
