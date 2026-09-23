import { describe, expect, it, vi } from 'vitest'

import {
  describeCatalog,
  executeSelectionPlan,
  MODEL_ROUTING,
  planModeSelection,
  planModelSelection,
  routingPolicyFor,
  type HarnessCatalog,
  type SelectionProvider,
} from '../src/main/agents/model-routing.js'

function select(id: string, category: string, currentValue: string, values: string[]) {
  return {
    id,
    category,
    currentValue,
    options: values.map(value => ({ value, name: value })),
  }
}

function catalog(session: unknown): HarnessCatalog {
  return describeCatalog(session)
}

function writes(plan: ReturnType<typeof planModelSelection> | ReturnType<typeof planModeSelection>) {
  return plan.attempts.map(({ writes: attemptWrites, appliedId }) => ({ writes: attemptWrites, appliedId }))
}

const routingCases = [
  {
    name: 'codex decomposes a bracketed model id',
    kind: 'codex',
    session: {
      configOptions: [
        select('model', 'model', 'other', ['gpt-5.5', 'other']),
        { ...select('reasoning_effort', 'thought_level', 'high', ['high', 'low']) },
      ],
    },
    id: 'gpt-5.5[low]',
    expected: [{ via: 'config', configId: 'model', value: 'gpt-5.5' }, { via: 'config', configId: 'reasoning_effort', value: 'low' }],
    appliedId: 'gpt-5.5',
  },
  {
    name: 'pi prefers the config model and legacy mode',
    kind: 'pi',
    session: {
      models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
      modes: { availableModes: [{ id: 'low', name: 'Low' }], currentModeId: 'medium' },
      configOptions: [select('model', 'model', 'a', ['a', 'b']), select('thought_level', 'thought_level', 'medium', ['low', 'medium'])],
    },
    id: 'b',
    expected: [{ via: 'config', configId: 'model', value: 'b' }],
    appliedId: 'b',
  },
  {
    name: 'opencode uses config for both selections',
    kind: 'opencode',
    session: {
      configOptions: [select('model', 'model', 'a', ['a', 'b']), select('mode', 'mode', 'build', ['build', 'plan'])],
    },
    id: 'plan',
    expected: [{ via: 'config', configId: 'mode', value: 'plan' }],
    appliedId: 'plan',
    mode: true,
  },
  {
    name: 'claude keeps legacy modes beside config model and effort',
    kind: 'claude',
    session: {
      modes: { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'default' },
      configOptions: [select('model', 'model', 'sonnet', ['sonnet', 'opus']), select('reasoning_effort', 'thought_level', 'medium', ['low', 'medium'])],
    },
    id: 'plan',
    expected: [{ via: 'legacy', value: 'plan' }],
    appliedId: 'plan',
    mode: true,
  },
] as const

describe('model-routing catalogs and policies', () => {
  it.each(routingCases)('$name', ({ kind, session, id, expected, appliedId, mode }) => {
    const policy = routingPolicyFor(kind)
    const plan = mode
      ? planModeSelection(policy, catalog(session), id)
      : planModelSelection(policy, catalog(session), id)
    expect(writes(plan)).toEqual([{ writes: expected, appliedId }])
  })

  it('decomposes an already-current bracketed Codex pick into no writes', () => {
    const session = {
      configOptions: [
        select('model', 'model', 'gpt-5.5', ['gpt-5.5']),
        select('reasoning_effort', 'thought_level', 'low', ['high', 'low']),
      ],
    }
    const plan = planModelSelection(routingPolicyFor('codex'), catalog(session), 'gpt-5.5[low]')
    expect(writes(plan)).toEqual([{ writes: [], appliedId: 'gpt-5.5' }])
  })

  it('routes Pi thinking modes through legacy setMode', () => {
    const session = {
      modes: { availableModes: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], currentModeId: 'medium' },
      configOptions: [select('thought_level', 'thought_level', 'medium', ['low', 'medium'])],
    }
    const plan = planModeSelection(routingPolicyFor('pi'), catalog(session), 'low')
    expect(writes(plan)).toEqual([
      { writes: [{ via: 'legacy', value: 'low' }], appliedId: 'low' },
      { writes: [{ via: 'config', configId: 'thought_level', value: 'low' }], appliedId: 'low' },
    ])
  })

  it('keeps OpenCode model and mode writes on configOptions', () => {
    const session = { configOptions: [select('model', 'model', 'a', ['a', 'b']), select('mode', 'mode', 'build', ['build', 'plan'])] }
    const modelPlan = planModelSelection(routingPolicyFor('opencode'), catalog(session), 'b')
    const modePlan = planModeSelection(routingPolicyFor('opencode'), catalog(session), 'plan')
    expect(writes(modelPlan)).toEqual([{ writes: [{ via: 'config', configId: 'model', value: 'b' }], appliedId: 'b' }])
    expect(writes(modePlan)).toEqual([{ writes: [{ via: 'config', configId: 'mode', value: 'plan' }], appliedId: 'plan' }])
  })

  it('supports Claude config model/effort beside legacy modes', () => {
    const session = {
      modes: { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'default' },
      configOptions: [select('model', 'model', 'sonnet', ['sonnet', 'opus']), select('reasoning_effort', 'thought_level', 'medium', ['low', 'medium'])],
    }
    const modelPlan = planModelSelection(routingPolicyFor('claude'), catalog(session), 'opus[low]')
    const modePlan = planModeSelection(routingPolicyFor('claude'), catalog(session), 'plan')
    expect(writes(modelPlan)).toEqual([{
      writes: [{ via: 'config', configId: 'model', value: 'opus' }, { via: 'config', configId: 'reasoning_effort', value: 'low' }],
      appliedId: 'opus',
    }])
    expect(writes(modePlan)).toEqual([{ writes: [{ via: 'legacy', value: 'plan' }], appliedId: 'plan' }])
  })

  it('degrades an unknown Codex effort suffix to the base model', () => {
    const session = { configOptions: [select('model', 'model', 'gpt-5.5', ['gpt-5.5'])] }
    const plan = planModelSelection(routingPolicyFor('codex'), catalog(session), 'gpt-5.5[ultra]')
    expect(writes(plan)).toEqual([{ writes: [], appliedId: 'gpt-5.5' }])
  })

  it('migrates a stale bracketed pick to an advertised base', () => {
    const session = {
      models: { availableModels: [{ modelId: 'gpt-5.5', name: 'GPT' }], currentModelId: 'other' },
      configOptions: [select('model', 'model', 'other', ['gpt-5.5', 'other'])],
    }
    const plan = planModelSelection(routingPolicyFor('codex'), catalog(session), 'gpt-5.5[low]')
    expect(writes(plan)).toEqual([{ writes: [{ via: 'config', configId: 'model', value: 'gpt-5.5' }], appliedId: 'gpt-5.5' }])
  })

  it('guesses minimal resumed-session writes in the documented order', () => {
    const empty = catalog({})
    expect(writes(planModelSelection(routingPolicyFor('unknown'), empty, 'm'))).toEqual([
      { writes: [{ via: 'config', configId: 'model', value: 'm' }], appliedId: 'm' },
      { writes: [{ via: 'legacy', value: 'm' }], appliedId: 'm' },
    ])
    expect(writes(planModeSelection(routingPolicyFor('unknown'), empty, 'plan'))).toEqual([
      { writes: [{ via: 'config', configId: 'mode', value: 'plan' }], appliedId: 'plan' },
      { writes: [{ via: 'config', configId: 'thought_level', value: 'plan' }], appliedId: 'plan' },
      { writes: [{ via: 'legacy', value: 'plan' }], appliedId: 'plan' },
    ])
  })

  it('uses the default policy for unknown kinds', () => {
    expect(routingPolicyFor('new-harness')).toBe(MODEL_ROUTING.default)
    expect(routingPolicyFor('new-harness')).toEqual(MODEL_ROUTING.default)
  })

  it('never throws for malformed catalogs and preserves grouped labels', () => {
    expect(() => describeCatalog({ models: { availableModels: 'nope' }, configOptions: 'nope' })).not.toThrow()
    expect(describeCatalog({ models: { availableModels: [{}] }, modes: { availableModes: [{}] } })).toEqual({ selects: {}, legacy: {} })
    const result = describeCatalog({
      configOptions: [{
        id: 'model',
        currentValue: 'a-1',
        options: [{ name: 'Group A', options: [{ value: 'a-1', name: 'One' }] }],
      }],
    })
    expect(result.models?.availableModels[0]?.name).toBe('Group A / One')
  })
})

describe('model-routing executor', () => {
  it('runs the next alternative after a failed primary write', async () => {
    const provider: SelectionProvider = {
      setConfigOption: vi.fn(async () => { throw new Error('config unavailable') }),
      setModel: vi.fn(async () => ({})),
    }
    const plan = planModelSelection(
      routingPolicyFor('default'),
      catalog({
        models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'old' },
        configOptions: [select('model', 'model', 'old', ['a'])],
      }),
      'a',
    )
    await expect(executeSelectionPlan(provider, 'sess', plan)).resolves.toBe('a')
    expect(provider.setModel).toHaveBeenCalledWith('a')
  })

  it('skips a missing setter for a valid catalog route', async () => {
    const plan = planModelSelection(routingPolicyFor('default'), catalog({ configOptions: [select('model', 'model', 'a', ['a', 'b'])] }), 'b')
    await expect(executeSelectionPlan({}, 'sess', plan)).resolves.toBe('b')
  })

  it('rethrows the primary provider error when all alternatives fail', async () => {
    const error = new Error('Invalid params')
    const provider: SelectionProvider = { setConfigOption: vi.fn(async () => { throw error }) }
    const plan = planModelSelection(routingPolicyFor('default'), catalog({ configOptions: [select('model', 'model', 'old', ['a'])] }), 'a')
    await expect(executeSelectionPlan(provider, 'sess', plan)).rejects.toBe(error)
  })

  it('surfaces the fallback error when the primary and its fallback both fail', async () => {
    const provider: SelectionProvider = {
      setConfigOption: vi.fn(async () => { throw new Error('config rejected') }),
      setModel: vi.fn(async () => { throw new Error('legacy rejected') }),
    }
    const plan = planModelSelection(
      routingPolicyFor('default'),
      catalog({
        models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'old' },
        configOptions: [select('model', 'model', 'old', ['a'])],
      }),
      'a',
    )
    await expect(executeSelectionPlan(provider, 'sess', plan)).rejects.toThrow('legacy rejected')
  })
})
