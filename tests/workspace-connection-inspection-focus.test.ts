import { RegistryContext } from '@effect/atom-react'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { connectionInspectionAtom } from '@/renderer/features/workspace/connection-atoms.js'
import { useInspectWorkspaceConnection } from '@/renderer/features/workspace/connection-hooks.js'
import type { WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

const supported = { support: 'supported' as const, restrictions: [], evidence: [] }

function inspection(connectionId: string): WorkspaceConnectionInspection {
  return {
    connectionId,
    driverId: 'acp',
    protocol: { state: 'initialized' },
    authentication: 'unknown',
    capabilities: {
      openSession: supported,
      loadSession: supported,
      submit: supported,
      interrupt: supported,
      steer: supported,
      respond: supported,
      reconcile: supported,
      models: { state: 'unknown', items: [] },
      modes: { state: 'unknown', items: [] },
    },
  }
}

type Inspector = ReturnType<typeof useInspectWorkspaceConnection>

/** Render-phase updates let React settle two actual hook instances without a browser or mocked hooks. */
function renderInspectors(registry: AtomRegistry.AtomRegistry, repeatFirst = false): readonly Inspector[] {
  let captured: readonly Inspector[] = []
  function Inspectors(): null {
    const first = useInspectWorkspaceConnection()
    const second = useInspectWorkspaceConnection()
    const [selected, setSelected] = useState(false)
    if (!selected) {
      void first.execute({ connectionId: 'parent-agent' })
      void second.execute({ connectionId: 'side-agent' })
      if (repeatFirst) void first.execute({ connectionId: 'parent-agent' })
      setSelected(true)
    }
    captured = [first, second]
    return null
  }
  renderToStaticMarkup(createElement(RegistryContext.Provider, { value: registry }, createElement(Inspectors)))
  return captured
}

describe('caller-local connection inspection', () => {
  it('keeps parent and side chat selections independent while sharing keyed cached facts', () => {
    const parent = inspection('parent-agent')
    const side = inspection('side-agent')
    const registry = AtomRegistry.make({
      initialValues: [
        [connectionInspectionAtom('parent-agent'), AsyncResult.success(parent)],
        [connectionInspectionAtom('side-agent'), AsyncResult.success(side, { waiting: true })],
      ],
    })
    try {
      const [first, second] = renderInspectors(registry)
      expect(first).toMatchObject({ data: parent, pending: false, error: null })
      expect(second).toMatchObject({ data: side, pending: true, error: null })
    } finally {
      registry.dispose()
    }
  })

  it('does not expose the other composer failure as the successful parent inspection', () => {
    const parent = inspection('parent-agent')
    const registry = AtomRegistry.make({
      initialValues: [
        [connectionInspectionAtom('parent-agent'), AsyncResult.success(parent)],
        [connectionInspectionAtom('side-agent'), AsyncResult.fail(new Error('Side agent unavailable'))],
      ],
    })
    try {
      const [first, second] = renderInspectors(registry)
      expect(first).toMatchObject({ data: parent, pending: false, error: null })
      expect(second).toMatchObject({ data: null, pending: false, error: 'Side agent unavailable' })
    } finally {
      registry.dispose()
    }
  })

  it('refreshes only the repeated caller selection after another composer selects its own agent', () => {
    const registry = AtomRegistry.make()
    const refresh = vi.spyOn(registry, 'refresh').mockImplementation(() => {})
    try {
      renderInspectors(registry, true)
      expect(refresh).toHaveBeenCalledExactlyOnceWith(connectionInspectionAtom('parent-agent'))
    } finally {
      registry.dispose()
    }
  })
})
