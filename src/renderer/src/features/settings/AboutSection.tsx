import { Download, ExternalLink, RefreshCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { releasePageUrl, REPO_URL, type UpdateStatus } from '@/features/settings/updates'
import { Button } from '@/shared/components/ui/button'
import {
  type ApiResult,
  fetchAppVersion,
  fetchCheckForUpdates,
  fetchDownloadUpdate,
  fetchInstallUpdate,
  fetchUpdateStatus,
  onUpdateChanged,
} from '@/shared/lib/api'

export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let changed = false
    const unsubscribe = onUpdateChanged(next => {
      changed = true
      if (active) {
        setStatus(next)
        setError(null)
      }
    })
    void fetchAppVersion().then(result => {
      if (active) setVersion(result.ok ? result.data : 'unknown')
    })
    void fetchUpdateStatus().then(result => {
      if (!active || changed) return
      if (result.ok) setStatus(result.data)
      else setError('Unable to read update status. Reopen Settings to try again.')
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  async function run(command: () => Promise<ApiResult<UpdateStatus>>): Promise<void> {
    setPending(true)
    setError(null)
    const result = await command()
    if (result.ok) setStatus(result.data)
    else setError('The update request failed. Try again or open the release page.')
    setPending(false)
  }

  const busy =
    pending || status?.phase === 'checking' || status?.phase === 'downloading' || status?.phase === 'installing'
  const canDownload =
    status?.installSupported && status.updateAvailable && (status.phase === 'available' || status.phase === 'error')
  const releaseUrl = status?.tag ? releasePageUrl(status.tag) : `${REPO_URL}/releases/latest`

  return (
    <div>
      <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">About</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-foreground text-[12.5px]">{version ? `Version ${version}` : '…'}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!status?.installSupported || busy || status.phase === 'ready'}
          onClick={() => void run(fetchCheckForUpdates)}
          className="text-[11px]"
        >
          <RefreshCcw className={status?.phase === 'checking' ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {status?.phase === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>
        {canDownload && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(fetchDownloadUpdate)}
            className="text-[11px]"
          >
            <Download className="size-3.5" />
            Download update
          </Button>
        )}
        {status?.phase === 'ready' && (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void run(fetchInstallUpdate)}
            className="text-[11px]"
          >
            Restart to install
          </Button>
        )}
      </div>
      <div aria-live="polite" className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
        {status?.phase === 'current' && <p>You're on the latest compatible stable version.</p>}
        {status?.phase === 'available' && <p>Update available: {status.latestVersion}</p>}
        {status?.phase === 'downloading' && (
          <div>
            <p>Downloading update: {Math.floor(status.progress ?? 0)}%</p>
            <progress className="mt-1 w-48" aria-label="Update download" value={status.progress ?? 0} max={100} />
          </div>
        )}
        {status?.phase === 'ready' && <p>Version {status.latestVersion} is ready. Restart to install it.</p>}
        {status?.phase === 'installing' && <p>Closing Watchtower to install the update…</p>}
        {status?.message && <p>{status.message}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
        <button
          type="button"
          className="decoration-brand-text/40 text-brand-text inline underline underline-offset-2"
          onClick={() => void window.api.openExternal(releaseUrl)}
        >
          Open release page <ExternalLink className="inline size-3" />
        </button>
      </p>
      <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
        Watchtower is open source ·{' '}
        <button
          type="button"
          className="decoration-brand-text/40 text-brand-text inline underline underline-offset-2"
          onClick={() => void window.api.openExternal(REPO_URL)}
        >
          GitHub repository <ExternalLink className="inline size-3" />
        </button>
      </p>
    </div>
  )
}
