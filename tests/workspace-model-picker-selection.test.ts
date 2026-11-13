import { describe, expect, it } from 'vitest'

import {
  catalogView,
  connectionStatus,
  effortFor,
  knownModels,
  type ModelChoice,
} from '@/renderer/features/workspace/model-picker/catalog.js'
import {
  modeForModelCommit,
  normalizationFor,
  resolveAgentChoice,
} from '@/renderer/features/workspace/model-picker/selection.js'
import type { WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

const models: readonly ModelChoice[] = [
  {
    id: 'fast',
    label: 'Fast',
    modes: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
  },
  { id: 'plain', label: 'Plain' },
]

const capability = { support: 'supported' as const, restrictions: [], evidence: [] }

function inspection(
  models: WorkspaceConnectionInspection['capabilities']['models'],
  modes: WorkspaceConnectionInspection['capabilities']['modes'] = { state: 'unknown', items: [] },
  protocol: 'initialized' | 'not-established' = 'initialized',
): WorkspaceConnectionInspection {
  return {
    connectionId: 'codex-local',
    driverId: 'acp',
    protocol: { state: protocol },
    authentication: 'unknown',
    capabilities: {
      openSession: capability,
      loadSession: capability,
      submit: capability,
      interrupt: capability,
      steer: capability,
      respond: capability,
      reconcile: capability,
      models,
      modes,
    },
  }
}

const blank = { modelId: '', modeId: '' }

describe('resolveAgentChoice precedence', () => {
  it('prefers the Conversation own choice over the remembered one', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: 'fast', modeId: '' },
      remembered: { modelId: 'plain', modeId: '' },
      models,
      connectionEffort: null,
    })
    expect(resolved).toEqual({ choice: { modelId: 'fast', modeId: '' }, source: 'conversation' })
  })

  it('uses the remembered choice for the connection when the Conversation has none', () => {
    const resolved = resolveAgentChoice({
      conversation: blank,
      remembered: { modelId: 'plain', modeId: '' },
      models,
      connectionEffort: null,
    })
    expect(resolved).toEqual({ choice: { modelId: 'plain', modeId: '' }, source: 'remembered' })
  })

  it('falls back to the agent default when neither source has a choice', () => {
    expect(resolveAgentChoice({ conversation: blank, remembered: undefined, models, connectionEffort: null })).toEqual({
      choice: blank,
      source: 'default',
    })
  })

  it('treats a remembered default as no choice, so the agent default applies', () => {
    const resolved = resolveAgentChoice({ conversation: blank, remembered: blank, models, connectionEffort: null })
    expect(resolved.source).toBe('default')
  })

  it('lets a Conversation effort count as its own choice even without a model', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: '', modeId: 'high' },
      remembered: { modelId: 'plain', modeId: '' },
      models,
      connectionEffort: [{ id: 'high', label: 'High' }],
    })
    expect(resolved).toEqual({ choice: { modelId: '', modeId: 'high' }, source: 'conversation' })
  })
})

describe('resolveAgentChoice fallback and effort validity', () => {
  it('falls back silently to the agent default when the model is missing from a known catalog', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: 'retired', modeId: 'high' },
      remembered: undefined,
      models,
      connectionEffort: null,
    })
    expect(resolved).toEqual({ choice: blank, source: 'default' })
  })

  it('keeps the chosen model while the catalog is unknown', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: 'retired', modeId: '' },
      remembered: undefined,
      models: null,
      connectionEffort: null,
    })
    expect(resolved.choice).toEqual({ modelId: 'retired', modeId: '' })
  })

  it('keeps an effort while the model options are unknown', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: 'fast', modeId: 'high' },
      remembered: undefined,
      models: null,
      connectionEffort: null,
    })
    expect(resolved.choice).toEqual({ modelId: 'fast', modeId: 'high' })
  })

  it('keeps an effort the selected model offers', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: 'fast', modeId: 'high' },
      remembered: undefined,
      models,
      connectionEffort: null,
    })
    expect(resolved.choice).toEqual({ modelId: 'fast', modeId: 'high' })
  })

  it('drops an effort the new model does not offer and keeps the model', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: 'fast', modeId: 'turbo' },
      remembered: undefined,
      models,
      connectionEffort: null,
    })
    expect(resolved.choice).toEqual({ modelId: 'fast', modeId: '' })
  })

  it('drops an effort when the model declares no effort choices', () => {
    const resolved = resolveAgentChoice({
      conversation: { modelId: 'plain', modeId: 'low' },
      remembered: undefined,
      models,
      connectionEffort: null,
    })
    expect(resolved.choice).toEqual({ modelId: 'plain', modeId: '' })
  })

  it('checks the effort of a default model against the connection-level choices', () => {
    const connectionEffort = [{ id: 'medium', label: 'Medium' }]
    const kept = resolveAgentChoice({
      conversation: { modelId: '', modeId: 'medium' },
      remembered: undefined,
      models,
      connectionEffort,
    })
    const dropped = resolveAgentChoice({
      conversation: { modelId: '', modeId: 'low' },
      remembered: undefined,
      models,
      connectionEffort,
    })
    expect(kept.choice).toEqual({ modelId: '', modeId: 'medium' })
    expect(dropped.choice).toEqual({ modelId: '', modeId: '' })
  })
})

describe('effortFor', () => {
  it('lists the model choices and offers none for a known model without them', () => {
    expect(effortFor({ models, connectionEffort: null, modelId: 'fast' })?.map(effort => effort.id)).toEqual([
      'low',
      'high',
    ])
    expect(effortFor({ models, connectionEffort: null, modelId: 'plain' })).toEqual([])
  })

  it('is unknown for an unknown model or an unknown catalog', () => {
    expect(effortFor({ models, connectionEffort: null, modelId: 'retired' })).toBeNull()
    expect(effortFor({ models: null, connectionEffort: null, modelId: 'fast' })).toBeNull()
  })
})

describe('modeForModelCommit', () => {
  it('keeps the previewed mode when the selected model offers it', () => {
    expect(
      modeForModelCommit({
        previewIsActive: false,
        modelId: 'fast',
        modeId: 'high',
        models,
        connectionEffort: null,
      }),
    ).toBe('high')
  })

  it('clears the previewed mode when the selected model does not offer it', () => {
    expect(
      modeForModelCommit({
        previewIsActive: false,
        modelId: 'plain',
        modeId: 'high',
        models,
        connectionEffort: null,
      }),
    ).toBe('')
  })

  it('resets the mode when changing the active connection model', () => {
    expect(
      modeForModelCommit({
        previewIsActive: true,
        modelId: 'fast',
        modeId: 'high',
        models,
        connectionEffort: null,
      }),
    ).toBe('')
  })
})

describe('normalizationFor', () => {
  it('returns nothing when the parent already holds the shown choice', () => {
    expect(normalizationFor({ modelId: 'fast', modeId: 'low' }, { modelId: 'fast', modeId: 'low' })).toBeNull()
  })

  it('updates the model and carries an effort only when the model changed', () => {
    expect(normalizationFor({ modelId: 'retired', modeId: 'high' }, blank)).toEqual({ modelId: '' })
    expect(normalizationFor({ modelId: 'plain', modeId: 'x' }, { modelId: 'fast', modeId: 'low' })).toEqual({
      modelId: 'fast',
      modeId: 'low',
    })
  })

  it('updates only the effort when the model already matches', () => {
    expect(normalizationFor({ modelId: 'fast', modeId: 'turbo' }, { modelId: 'fast', modeId: '' })).toEqual({
      modeId: '',
    })
  })
})

describe('catalogView', () => {
  it('lists a connection-scoped catalog, including an empty one', () => {
    const view = catalogView({
      inspection: inspection({ state: 'connection-scoped', items: models }),
      failed: false,
    })
    expect(view).toEqual({ kind: 'listed', models })
    expect(knownModels(view)).toEqual(models)
    expect(
      knownModels(catalogView({ inspection: inspection({ state: 'connection-scoped', items: [] }), failed: false })),
    ).toEqual([])
  })

  it('shows only the observed models for a session-scoped or unknown catalog', () => {
    const observed = [{ id: 'live', label: 'Live' }]
    expect(catalogView({ inspection: inspection({ state: 'unknown', items: [] }), failed: false })).toEqual({
      kind: 'session',
      models: [],
    })
    expect(
      knownModels(catalogView({ inspection: inspection({ state: 'unknown', items: [] }), failed: false })),
    ).toBeNull()
    expect(
      catalogView({ inspection: inspection({ state: 'unknown', items: [] }), failed: false, sessionModels: observed }),
    ).toEqual({ kind: 'session', models: observed })
  })

  it('uses the session models a parent merged into a session-scoped inspection', () => {
    const merged = inspection({ state: 'session-scoped', items: observedModels() })
    expect(catalogView({ inspection: merged, failed: false })).toEqual({ kind: 'session', models: observedModels() })
  })

  it('is loading before any inspection and failed when inspection failed without a value', () => {
    expect(catalogView({ inspection: null, failed: false })).toEqual({ kind: 'loading' })
    expect(catalogView({ inspection: null, failed: true })).toEqual({ kind: 'failed' })
    expect(knownModels({ kind: 'failed' })).toBeNull()
  })

  it('reports the rail status from the inspection state', () => {
    expect(connectionStatus({ inspection: null, pending: true, failed: false })).toBe('pending')
    expect(connectionStatus({ inspection: null, pending: false, failed: true })).toBe('error')
    expect(
      connectionStatus({ inspection: inspection({ state: 'unknown', items: [] }), pending: false, failed: false }),
    ).toBe('ready')
    expect(
      connectionStatus({
        inspection: inspection({ state: 'unknown', items: [] }, undefined, 'not-established'),
        pending: false,
        failed: false,
      }),
    ).toBe('warning')
    expect(connectionStatus({ inspection: null, pending: false, failed: false })).toBe('ready')
  })
})

function observedModels(): readonly ModelChoice[] {
  return [{ id: 'observed', label: 'Observed' }]
}
