import { PREFERENCES_STORAGE_KEY, type PreferenceStorage } from './preferences.js'

/** Adapts one renderer window without reading browser globals at module load. */
export function browserPreferenceStorage(browser: Window): PreferenceStorage {
  return {
    getItem: key => browser.localStorage.getItem(key),
    setItem: (key, value) => browser.localStorage.setItem(key, value),
    subscribe: listener => {
      const onStorage = (event: StorageEvent): void => {
        if (event.key === PREFERENCES_STORAGE_KEY || event.key === null) listener(event.newValue)
      }
      browser.addEventListener('storage', onStorage)
      return () => browser.removeEventListener('storage', onStorage)
    },
  }
}
