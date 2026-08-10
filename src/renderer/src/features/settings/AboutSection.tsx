import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, RefreshCcw } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { REPO_URL, releasePageUrl, type UpdateStatus } from '@/features/settings/updates'
import { fetchAppVersion, fetchCheckForUpdates } from '@/shared/lib/api'

/**
 * Settings › General's About/version area (ADR 0012): shows the running
 * version and a manual "Check for updates" button. Clicking it queries the
 * Watchtower repo's GitHub Releases feed once and only informs the user
 * whether a newer version exists — it never downloads or installs, and there
 * is no automatic background check anywhere.
 */
export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void fetchAppVersion().then(result => setVersion(result.ok ? result.data : 'unknown'))
  }, [])

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    const result = await fetchCheckForUpdates()
    if (result.ok) {
      setStatus(result.data)
    } else {
      // The main-process checker already swallows GitHub errors, but an IPC
      // failure itself (uninitialised checker, channel error) or a malformed
      // update-status payload must also degrade to the informational "unable
      // to check" state rather than an unhandled rejection.
      setStatus({ currentVersion: version ?? '', latestVersion: null, updateAvailable: false, tag: null })
    }
    setChecking(false)
  }, [version])

  return (
    <div>
      <p className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">About</p>
      <div className="mt-2 flex items-center gap-3">
        <span className="text-[12.5px] text-foreground">
          {version ? `Version ${version}` : '…'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void check()}
          disabled={checking}
          className="text-[11px]"
        >
          <RefreshCcw className={checking ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>
      {status && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          {status.updateAvailable && status.tag ? (
            <>
              Update available: {status.latestVersion} ·{' '}
              <button
                type="button"
                className="inline underline decoration-brand-text/40 underline-offset-2 text-brand-text"
                onClick={() => void window.api.openExternal(releasePageUrl(status.tag!))}
              >
                Open release page <ExternalLink className="inline size-3" />
              </button>
            </>
          ) : status.latestVersion ? (
            "You're on the latest version."
          ) : (
            'Unable to check right now.'
          )}
        </p>
      )}
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        Watchtower is open source —{' '}
        <button
          type="button"
          className="inline underline decoration-brand-text/40 underline-offset-2 text-brand-text"
          onClick={() => void window.api.openExternal(REPO_URL)}
        >
          GitHub repository <ExternalLink className="inline size-3" />
        </button>
      </p>
    </div>
  )
}
