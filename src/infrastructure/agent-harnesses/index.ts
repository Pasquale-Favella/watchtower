export { deriveCoachEvents, type CoachStreamPart } from '@/infrastructure/agent-harnesses/events.js'
export {
  detectHarnesses,
  pickPreferredHarness,
  which,
  type DetectOptions,
  type HarnessAuthStatus,
  type HarnessInfo,
} from '@/infrastructure/agent-harnesses/detect.js'
export {
  assertRealWorkspacePath,
  createHarnessRuntime,
  loadHarnessSdk,
  type AcpProvider,
  type AcpProviderConfig,
  type HarnessRuntime,
  type HarnessRunInput,
  type HarnessSdk,
} from '@/infrastructure/agent-harnesses/runtime.js'
