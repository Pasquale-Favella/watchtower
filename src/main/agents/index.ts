export { deriveCoachEvents, type CoachStreamPart } from './events.js'
export {
  detectHarnesses,
  pickPreferredHarness,
  which,
  type DetectOptions,
  type HarnessAuthStatus,
  type HarnessInfo,
} from './detect.js'
export {
  assertRealWorkspacePath,
  createHarnessRuntime,
  loadHarnessSdk,
  type AcpProvider,
  type AcpProviderConfig,
  type HarnessRuntime,
  type HarnessRunInput,
  type HarnessSdk,
} from './runtime.js'
