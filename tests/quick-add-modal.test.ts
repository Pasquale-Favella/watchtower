import { RegistryContext } from '@effect/atom-react'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { QuickAddModal } from '../src/renderer/src/features/models/quick-add-modal.js'

const hookQueries = vi.hoisted(() => ({
  values: [] as Array<{ data: unknown | null; error: string | null; status: 'loading' | 'ready' }>,
}))

vi.mock('../src/renderer/src/app/hooks/use-remote-query.js', () => ({
  pinWindowAtom: () => {},
  useRemoteQuery: () => hookQueries.values.shift()!,
}))

vi.mock('../src/renderer/src/shared/components/ui/dialog.js', () => {
  const element = (name: string) => ({ children, ...props }: { children?: ReactNode }) =>
    createElement(name, props, children)
  return {
    Dialog: element('div'),
    DialogContent: element('section'),
    DialogDescription: element('p'),
    DialogFooter: element('footer'),
    DialogHeader: element('header'),
    DialogTitle: element('h2'),
  }
})

vi.mock('../src/renderer/src/features/models/model-picker.js', () => ({
  ModelPickerCombobox: ({ groups }: { groups: Array<{ label: string; items: Array<{ label: string }> }> }) =>
    createElement(
      'div',
      null,
      ...groups.flatMap(group => [
        createElement('h3', { key: `${group.label}-title` }, group.label),
        ...group.items.map(item => createElement('span', { key: item.label }, item.label)),
      ]),
    ),
}))

function renderQuickAdd(
  queries: Array<{ data: unknown | null; error: string | null; status: 'loading' | 'ready' }>,
): string {
  hookQueries.values = [...queries]
  const registry = AtomRegistry.make()
  try {
    return renderToStaticMarkup(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(QuickAddModal, {
          target: {
            provider: 'custom',
            model: 'local-model',
            modelDisplayName: 'Local model',
            initialMode: 'alias',
          },
          models: [],
          onClose: () => {},
          onSaved: () => {},
        }),
      ),
    )
  } finally {
    registry.dispose()
  }
}

describe('QuickAddModal query errors', () => {
  it('shows a blocking error when pricing queries fail before any data loads', () => {
    const markup = renderQuickAdd([
      { data: null, error: 'Aliases are unavailable.', status: 'ready' },
      { data: null, error: 'Overrides are unavailable.', status: 'ready' },
    ])

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Aliases are unavailable.')
    expect(markup).toContain('Overrides are unavailable.')
  })

  it('keeps last good alias choices visible with a nonblocking refresh error', () => {
    const markup = renderQuickAdd([
      {
        data: [{ model: 'old-local-model', aliasOf: 'retained-target' }],
        error: 'Aliases are unavailable.',
        status: 'ready',
      },
      {
        data: [{ model: 'retained-override', inputPricePerMillion: 1, outputPricePerMillion: 2 }],
        error: 'Overrides are unavailable.',
        status: 'ready',
      },
    ])

    expect(markup).toContain('retained-target')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Refresh failed: Aliases are unavailable.')
    expect(markup).toContain('Refresh failed: Overrides are unavailable.')
    expect(markup).not.toContain('role="alert"')
  })
})
