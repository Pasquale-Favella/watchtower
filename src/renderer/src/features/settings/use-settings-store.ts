import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import { useCallback, useContext, useEffect } from 'react'

import { scanStateAtom } from '@/app/atoms/scan'
import { pinWindowAtom, querySnapshot, useRemoteQuery } from '@/app/hooks/use-remote-query'

import { activeCurrencyAtom, cadenceAtom, currencyOptionsAtom, setCadenceAtom, setCurrencyAtom } from './atoms'
import {
  clearDataAtom,
  getMcpConnectionAtom,
  MCP_STATUS_REQUEST,
  mcpStatusQuery,
  openSystemSettingsAtom,
  PROVIDERS_REQUEST,
  providersQuery,
  regenerateMcpTokenAtom,
  setMcpStartupModeAtom,
  SETTINGS_INFO_REQUEST,
  settingsInfoQuery,
} from './capability-atoms'
import {
  exportMachineAtom,
  exportNowAtom,
  selectExportFormat,
  selectExporting,
  selectExportMessage,
  selectExportFormatAtom,
} from './export-atoms'
import { preferencesAtom, setPreferencesAtom } from './preferences-atoms'
import {
  canRequestUpdate,
  selectUpdateActivity,
  selectUpdateCommandVisible,
  selectUpdateError,
  selectUpdateStatus,
  checkForUpdatesAtom,
  downloadUpdateAtom,
  installUpdateAtom,
  loadUpdateStatusAtom,
  updatesMachineAtom,
} from './updates-atoms'

export function useSettingsPreferencesStore() {
  return { preferences: useAtomValue(preferencesAtom), setPreferences: useAtomSet(setPreferencesAtom) }
}

export function useSettingsGeneralStore() {
  const cadenceChange = useAtomValue(setCadenceAtom)
  const currencyChange = useAtomValue(setCurrencyAtom)
  const cadenceError = querySnapshot(cadenceChange).error
  const currencyError = querySnapshot(currencyChange).error
  return {
    fdaNeeded: useAtomValue(scanStateAtom).fdaNeeded,
    preferences: useAtomValue(preferencesAtom),
    cadence: useAtomValue(cadenceAtom),
    currency: useAtomValue(activeCurrencyAtom),
    currencyOptions: useAtomValue(currencyOptionsAtom),
    setPreferences: useAtomSet(setPreferencesAtom),
    setCadence: useAtomSet(setCadenceAtom),
    setCurrency: useAtomSet(setCurrencyAtom),
    cadencePending: cadenceChange.waiting,
    currencyPending: currencyChange.waiting,
    cadenceError,
    currencyError,
    openSystemSettings: useAtomSet(openSystemSettingsAtom, { mode: 'promise' }),
    settingsInfo: useRemoteQuery(settingsInfoQuery, SETTINGS_INFO_REQUEST, () => 'settings-info'),
  }
}

export function useSettingsProvidersStore() {
  return useRemoteQuery(providersQuery, PROVIDERS_REQUEST, () => 'providers')
}

export function useSettingsPrivacyStore() {
  return {
    info: useRemoteQuery(settingsInfoQuery, SETTINGS_INFO_REQUEST, () => 'settings-info'),
    clearData: useAtomSet(clearDataAtom, { mode: 'promise' }),
  }
}

export function useSettingsSkillsStore() {
  const { skillsFrequency, skillsSpread } = useAtomValue(preferencesAtom)
  return {
    frequency: skillsFrequency,
    spread: skillsSpread,
    updatePreferences: useAtomSet(setPreferencesAtom),
  }
}

export function useSettingsExportStore() {
  const machine = useAtomValue(exportMachineAtom)
  return {
    format: selectExportFormat(machine),
    exporting: selectExporting(machine),
    result: selectExportMessage(machine),
    selectFormat: useAtomSet(selectExportFormatAtom),
    exportNow: useAtomSet(exportNowAtom),
  }
}

export function useSettingsUpdatesStore() {
  const machine = useAtomValue(updatesMachineAtom)
  return {
    status: selectUpdateStatus(machine),
    activity: selectUpdateActivity(machine),
    error: selectUpdateError(machine),
    loadFailed: machine.state === 'load-error',
    canCheck: canRequestUpdate(machine, 'check'),
    canDownload: canRequestUpdate(machine, 'download'),
    canInstall: canRequestUpdate(machine, 'install'),
    showDownload: selectUpdateCommandVisible(machine, 'download'),
    showInstall: selectUpdateCommandVisible(machine, 'install'),
    check: useAtomSet(checkForUpdatesAtom),
    download: useAtomSet(downloadUpdateAtom),
    install: useAtomSet(installUpdateAtom),
    load: useAtomSet(loadUpdateStatusAtom),
  }
}

export function useSettingsMcpStore() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    pinWindowAtom(registry, setMcpStartupModeAtom)
    pinWindowAtom(registry, regenerateMcpTokenAtom)
  }, [registry])
  const resetConnection = useAtomSet(getMcpConnectionAtom)
  const clearConnection = useCallback(() => resetConnection(Atom.Reset), [resetConnection])
  return {
    status: useRemoteQuery(mcpStatusQuery, MCP_STATUS_REQUEST, () => 'mcp-status'),
    setStartupMode: useAtomSet(setMcpStartupModeAtom, { mode: 'promise' }),
    getConnection: useAtomSet(getMcpConnectionAtom, { mode: 'promise' }),
    clearConnection,
    regenerateToken: useAtomSet(regenerateMcpTokenAtom, { mode: 'promise' }),
  }
}
