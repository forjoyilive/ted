// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  DetailsPane,
  ListPane,
  ResizableSidebar,
  SidebarLayout,
} from '../src/renderer/components/ResizableSidebar.tsx'
import { readSidebarWidths } from '../src/renderer/sidebar-widths.ts'
import { appState } from './support/app.tsx'
import { required, user } from './support/component.ts'

let viewport = 1440
let resize: () => void = () => {}

beforeEach(() => {
  viewport = 1440
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = this.className === 'layout' ? viewport : 0
    return {
      width,
      height: 800,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 800,
      toJSON() {},
    }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
      }
    },
  )
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

function Layout({ hidden = false, inbox = false }: { hidden?: boolean; inbox?: boolean }) {
  return (
    <SidebarLayout className="layout">
      <ResizableSidebar side="navigation">
        <nav>Navigation</nav>
      </ResizableSidebar>
      {inbox && <ListPane aria-label="Inbox">Inbox</ListPane>}
      <main>Thread</main>
      <DetailsPane aria-label="Task details" hidden={hidden}>
        Details
      </DetailsPane>
    </SidebarLayout>
  )
}

type Side = 'Navigation' | 'List' | 'Details'
function separator(side: Side) {
  return screen.getByRole('separator', {
    name: side === 'List' ? 'List width' : `${side} sidebar width`,
  })
}
function width(side: Side) {
  return Number(separator(side).getAttribute('aria-valuenow'))
}
function drag(element: HTMLElement, from: number, to: number, end = 'pointerup') {
  fireEvent.pointerDown(element, { button: 0, clientX: from, pointerId: 1 })
  fireEvent.pointerMove(element, { clientX: to, pointerId: 1 })
  fireEvent(element, new PointerEvent(end, { bubbles: true, pointerId: 1 }))
}

test('both dividers drag in physical direction and remember widths after remount', () => {
  const mounted = render(<Layout />)
  expect([width('Navigation'), width('Details')]).toEqual([210, 320])
  drag(separator('Navigation'), 210, 270)
  drag(separator('Details'), 1120, 1000)
  expect([width('Navigation'), width('Details')]).toEqual([270, 440])
  expect(document.body.style.userSelect).toBe('')
  mounted.unmount()
  render(<Layout />)
  expect([width('Navigation'), width('Details')]).toEqual([270, 440])
})

test('limits, cancellation and reset leave selection and pointer capture usable', () => {
  const mounted = render(<Layout />)
  const left = separator('Navigation')
  drag(left, 210, -400, 'pointercancel')
  expect(width('Navigation')).toBe(180)
  expect(document.body.style.cursor).toBe('')
  drag(left, 180, 1500)
  expect(width('Navigation')).toBe(360)
  fireEvent.doubleClick(left)
  expect(width('Navigation')).toBe(210)
  drag(separator('Details'), 1120, -2000)
  expect(width('Details')).toBe(560)
  fireEvent.doubleClick(separator('Details'))
  expect(width('Details')).toBe(320)
  fireEvent.pointerDown(left, { button: 0, clientX: 210, pointerId: 1 })
  mounted.unmount()
  expect(document.body.style.userSelect).toBe('')
  expect(document.body.style.cursor).toBe('')
})

test('window constraints include the Inbox list and restore preferred widths when space returns', () => {
  const mounted = render(<Layout inbox />)
  drag(separator('Details'), 1120, 960)
  expect(width('Details')).toBe(480)
  const saved = readSidebarWidths()
  act(() => {
    viewport = 900
    resize()
  })
  expect([width('Navigation'), width('List'), width('Details')]).toEqual([210, 260, 260])
  expect(readSidebarWidths()).toEqual(saved)
  expect(Number(separator('Details').getAttribute('aria-valuemax'))).toBe(260)
  act(() => {
    viewport = 1440
    resize()
  })
  expect([width('List'), width('Details')]).toEqual([330, 480])
  mounted.rerender(<Layout hidden inbox />)
  expect(screen.queryByRole('separator', { name: 'Details sidebar width' })).toBeNull()
  mounted.rerender(<Layout inbox />)
  expect(width('Details')).toBe(480)
})

test('the list column drags, resets, keeps its width and gives way first in a narrow window', () => {
  const mounted = render(<Layout hidden inbox />)
  expect(width('List')).toBe(330)
  drag(separator('List'), 540, 640)
  expect(width('List')).toBe(430)
  drag(separator('List'), 640, 2000)
  expect(width('List')).toBe(640)
  drag(separator('List'), 850, 0)
  expect(width('List')).toBe(260)
  fireEvent.doubleClick(separator('List'))
  expect(width('List')).toBe(330)
  drag(separator('List'), 540, 690)
  mounted.unmount()
  render(<Layout inbox />)
  expect(width('List')).toBe(480)
  act(() => {
    viewport = 1200
    resize()
  })
  expect([width('Navigation'), width('List'), width('Details')]).toEqual([210, 350, 320])
  expect(readSidebarWidths().list).toBe(480)
})

test('invalid saved data falls back safely and finite widths are clamped', () => {
  localStorage.setItem('ted.sidebar.widths', '{bad')
  expect(readSidebarWidths()).toEqual({ navigation: 210, list: 330, details: 320 })
  localStorage.setItem(
    'ted.sidebar.widths',
    JSON.stringify({ navigation: 'big', list: 100, details: 900 }),
  )
  expect(readSidebarWidths()).toEqual({ navigation: 210, list: 260, details: 560 })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('Unavailable')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Unavailable')
  })
  render(<Layout />)
  drag(separator('Navigation'), 210, 240)
  expect(width('Navigation')).toBe(240)
})

test('the app routes divider keys before Board navigation, while unrelated keys remain unhandled', async () => {
  const app = appState()
  app.mount()
  const nav = await screen.findByRole('navigation', { name: 'Sidebar' })
  const divider = required(nav.parentElement?.querySelector('hr'))
  divider.focus()
  await user().keyboard('{ArrowRight}{Shift>}{ArrowRight}{/Shift}')
  expect(width('Navigation')).toBe(260)
  await user().keyboard('{Home}')
  expect(width('Navigation')).toBe(180)
  await user().keyboard('{End}')
  expect(width('Navigation')).toBe(360)
  await user().keyboard('{Control>}{ArrowLeft}{/Control}')
  expect(width('Navigation')).toBe(360)
})
