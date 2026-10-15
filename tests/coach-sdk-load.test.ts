import { describe, expect, it, vi } from 'vitest'

import { loadHarnessSdk } from '../src/main/agents/runtime.js'

vi.mock('ai', () => {
  throw new Error('private import path C:\\Users\\person\\sdk token=secret')
})

vi.mock('@mcpc-tech/acp-ai-provider', () => ({ createACPProvider: vi.fn() }))

describe('Coach SDK module loading', () => {
  it('tags a native import rejection without retaining its details', async () => {
    const failure = await loadHarnessSdk().catch(error => error)
    expect(failure).toMatchObject({
      _tag: 'CoachSdkFailure',
      stage: 'sdk-load',
      reason: 'rejected',
      authentication: false,
    })
    expect(Object.keys(failure).sort()).toEqual(['_tag', 'authentication', 'reason', 'stage'])
    expect(JSON.stringify(failure)).not.toContain('private')
    expect(JSON.stringify(failure)).not.toContain('secret')
  })
})
