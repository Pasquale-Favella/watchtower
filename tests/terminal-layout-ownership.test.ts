import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import {
  terminalLayoutKey,
  terminalLayoutsAtom,
  updateTerminalLayoutAtom,
} from '../src/renderer/features/workspace/terminal/terminal-layout-atoms.js'
import { type DraftTerminalTarget, terminalOwnerKey, type TerminalTarget } from '../src/shared/schemas/terminal.js'
import { taskIdSchema } from '../src/shared/schemas/workspace.js'
import * as Schema from 'effect/Schema'
import {
  PREVIOUS_CHECKOUT_DRAWER,
  terminalGroupContext,
} from '../src/renderer/features/workspace/terminal/use-terminal-group-context.js'

const draft: DraftTerminalTarget = { kind: 'draft', draftId: 'unsent', projectId: null }
describe('terminal layout ownership', () => {
  it('keeps previous-checkout shells accessible while new groups use the Task checkout', () => {
    const registry = AtomRegistry.make()
    try {
      const ownerKey = terminalOwnerKey(draft)
      const task: TerminalTarget = { kind: 'task', taskId: Schema.decodeUnknownSync(taskIdSchema)('new-worktree-task') }
      registry.set(updateTerminalLayoutAtom, { ownerKey, action: { kind: 'init' } })
      registry.set(updateTerminalLayoutAtom, { ownerKey, groupId: 'existing-panel', action: { kind: 'init' } })
      const layouts = registry.get(terminalLayoutsAtom)
      expect(terminalGroupContext(layouts, task, draft, PREVIOUS_CHECKOUT_DRAWER)).toEqual({
        target: draft,
        groupId: 'drawer',
        previousCheckout: true,
      })
      expect(terminalGroupContext(layouts, task, draft, 'existing-panel')).toEqual({
        target: draft,
        groupId: 'existing-panel',
        previousCheckout: true,
      })
      expect(terminalGroupContext(layouts, task, draft, 'new-panel')).toEqual({
        target: task,
        groupId: 'new-panel',
        previousCheckout: false,
      })
      registry.set(updateTerminalLayoutAtom, { ownerKey, action: { kind: 'close', id: 'term-1' } })
      registry.set(updateTerminalLayoutAtom, {
        ownerKey,
        groupId: 'existing-panel',
        action: { kind: 'close', id: 'term-2' },
      })
      expect(terminalGroupContext(registry.get(terminalLayoutsAtom), task, draft, 'another-new-panel').target).toEqual(
        task,
      )
    } finally {
      registry.dispose()
    }
  })
  it('allocates independent shells for a drawer and multiple side panels', () => {
    const registry = AtomRegistry.make()
    try {
      const ownerKey = terminalOwnerKey(draft)
      registry.set(updateTerminalLayoutAtom, { ownerKey, action: { kind: 'init' } })
      registry.set(updateTerminalLayoutAtom, { ownerKey, groupId: 'panel-a', action: { kind: 'init' } })
      registry.set(updateTerminalLayoutAtom, { ownerKey, groupId: 'panel-b', action: { kind: 'init' } })
      const state = registry.get(terminalLayoutsAtom)
      expect(state[ownerKey]?.terminals).toEqual(['term-1'])
      expect(state[terminalLayoutKey(ownerKey, 'panel-a')]?.terminals).toEqual(['term-2'])
      expect(state[terminalLayoutKey(ownerKey, 'panel-b')]?.terminals).toEqual(['term-3'])
    } finally {
      registry.dispose()
    }
  })
  it('limits each split group to four panes while allowing a new independent group', () => {
    const registry = AtomRegistry.make()
    try {
      const ownerKey = terminalOwnerKey(draft)
      registry.set(updateTerminalLayoutAtom, { ownerKey, action: { kind: 'init' } })
      for (let i = 0; i < 5; i++)
        registry.set(updateTerminalLayoutAtom, { ownerKey, action: { kind: 'split', direction: 'horizontal' } })
      expect(registry.get(terminalLayoutsAtom)[ownerKey]?.terminals).toHaveLength(4)
      registry.set(updateTerminalLayoutAtom, { ownerKey, action: { kind: 'create' } })
      const entry = registry.get(terminalLayoutsAtom)[ownerKey]
      expect(entry?.terminals).toHaveLength(5)
      expect(entry?.groups?.map(group => group.terminals.length)).toEqual([4, 1])
    } finally {
      registry.dispose()
    }
  })
})
