import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { type WorkspacePreviewRef, workspacePreviewUrlSchema } from '@/shared/schemas/workspace-preview.js'

const STORAGE_KEY = 'watchtower.workspace.browser-urls.v1'
const urlsSchema = Schema.Record(Schema.String, workspacePreviewUrlSchema)
const LIMIT = 100

interface PreviewStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

export function browserPreviewStorage(): PreviewStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function readUrls(storage: PreviewStorage | null): Record<string, string> {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw || raw.length > 1_000_000) return {}
    return Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(urlsSchema))(raw), () => ({}))
  } catch {
    return {}
  }
}

function identity(ref: WorkspacePreviewRef): string {
  return JSON.stringify([ref.ownerKey, ref.tabId])
}

export function readWorkspacePreviewUrl(storage: PreviewStorage | null, ref: WorkspacePreviewRef): string | undefined {
  return readUrls(storage)[identity(ref)]
}

export function rememberWorkspacePreviewUrl(
  storage: PreviewStorage | null,
  ref: WorkspacePreviewRef,
  url: string,
): void {
  if (!Schema.is(workspacePreviewUrlSchema)(url)) return
  const urls = readUrls(storage)
  const key = identity(ref)
  if (urls[key] === url) return
  const entries = Object.entries(urls).filter(([candidate]) => candidate !== key)
  entries.push([key, url])
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-LIMIT))))
  } catch {
    /* Browsing remains available without stored preferences. */
  }
}
