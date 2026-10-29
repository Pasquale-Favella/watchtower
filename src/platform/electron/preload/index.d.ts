import type { Api } from '@/platform/electron/preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export {}
