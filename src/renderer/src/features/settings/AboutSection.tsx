import { Download, ExternalLink, RefreshCcw } from 'lucide-react'

import { releasePageUrl, REPO_URL } from '@/features/settings/updates'
import {
  canRequestUpdate,
  selectUpdateActivity,
  selectUpdateError,
  selectUpdateStatus,
  useUpdatesStore,
} from '@/features/settings/updates-store'
import { Button } from '@/shared/components/ui/button'
import { openExternalUrl } from '@/shared/lib/api'

export function AboutSection(): React.JSX.Element {
  const machine = useUpdatesStore(s => s.machine)
  const check = useUpdatesStore(s => s.check)
  const download = useUpdatesStore(s => s.download)
  const install = useUpdatesStore(s => s.install)
  const load = useUpdatesStore(s => s.load)
  const status = selectUpdateStatus(machine)
  const activity = selectUpdateActivity(machine)
  const error = selectUpdateError(machine)
  const releaseUrl = status?.tag ? releasePageUrl(status.tag) : `${REPO_URL}/releases/latest`

  return (
    <div>
      <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">About</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-foreground text-[12.5px]">
          {status ? `Version ${status.currentVersion}` : 'Version unavailable'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canRequestUpdate(machine, 'check')}
          onClick={() => void check()}
          className="text-[11px]"
        >
          <RefreshCcw className={activity === 'check' ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {activity === 'check' ? 'Checking…' : 'Check for updates'}
        </Button>
        {status?.installSupported &&
          status.updateAvailable &&
          (status.phase === 'available' || status.phase === 'error') && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canRequestUpdate(machine, 'download')}
              onClick={() => void download()}
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
            disabled={!canRequestUpdate(machine, 'install')}
            onClick={() => void install()}
            className="text-[11px]"
          >
            Restart to install
          </Button>
        )}
      </div>
      {machine.state === 'load-error' && (
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} className="mt-2 text-[11px]">
          Retry update status
        </Button>
      )}
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
          onClick={() => void openExternalUrl(releaseUrl)}
        >
          Open release page <ExternalLink className="inline size-3" />
        </button>
      </p>
      <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
        Watchtower is open source ·{' '}
        <button
          type="button"
          className="decoration-brand-text/40 text-brand-text inline underline underline-offset-2"
          onClick={() => void openExternalUrl(REPO_URL)}
        >
          GitHub repository <ExternalLink className="inline size-3" />
        </button>
      </p>
    </div>
  )
}
