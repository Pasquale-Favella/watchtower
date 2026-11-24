import { RotateCcw, ScanSearch } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { Badge } from '@/renderer/components/ui/badge'
import { Button } from '@/renderer/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import {
  DEFAULT_SOURCE_CONTROL_PREFERENCES,
  MERGE_METHOD_OPTIONS,
  type MergeMethod,
  useSourceControlPreferences,
} from '@/renderer/features/workspace/source-control-preferences'

import { useSourceControlDiscovery } from './source-control-hooks'
import {
  githubSummary,
  githubTone,
  gitSummary,
  gitTone,
  isAccountRevealed,
  type SourceControlTone,
} from './source-control-state'

const TONE_CLASSES: Record<SourceControlTone, string> = {
  available: 'bg-emerald-500',
  unavailable: 'bg-amber-500',
  checking: 'bg-muted-foreground/40',
}
const TONE_LABELS: Record<SourceControlTone, string> = {
  available: 'Available',
  unavailable: 'Unavailable',
  checking: 'Checking',
}

function StatusDot({ tone }: { readonly tone: SourceControlTone }) {
  return (
    <span
      role="img"
      aria-label={TONE_LABELS[tone]}
      className={`mt-1 inline-block size-2 shrink-0 rounded-full ${TONE_CLASSES[tone]}`}
    />
  )
}

function Section({
  title,
  action,
  children,
}: {
  readonly title: string
  readonly action?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">{title}</h3>
        {action}
      </div>
      <div className="border-border divide-border flex flex-col divide-y rounded-lg border">{children}</div>
    </section>
  )
}

function ResetButton({ label, onReset }: { readonly label: string; readonly onReset: () => void }) {
  return (
    <TextTooltip
      label="Reset to default"
      trigger={
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={onReset}>
          <RotateCcw />
        </Button>
      }
    />
  )
}

/** A label with a muted description on the left and its control on the right. */
function SettingRow({
  id,
  label,
  description,
  control,
  onReset,
  resetLabel,
}: {
  readonly id: string
  readonly label: string
  readonly description: ReactNode
  readonly control: ReactNode
  readonly onReset?: (() => void) | undefined
  readonly resetLabel?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-foreground text-[12.5px] font-medium">
          {label}
        </label>
        <div className="text-muted-foreground text-[11px]">{description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onReset && <ResetButton label={resetLabel ?? `Reset ${label}`} onReset={onReset} />}
        {control}
      </div>
    </div>
  )
}

function Switch({
  id,
  checked,
  label,
  tooltip,
  onChange,
}: {
  readonly id: string
  readonly checked: boolean
  readonly label: string
  readonly tooltip: string
  readonly onChange: (checked: boolean) => void
}) {
  return (
    <TextTooltip
      label={tooltip}
      trigger={
        <button
          id={id}
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`border-border focus-visible:ring-ring/50 h-5 w-9 shrink-0 rounded-full border p-0.5 outline-none focus-visible:ring-3 ${checked ? 'bg-primary' : 'bg-muted'}`}
        >
          <span
            className={`bg-background block size-3.5 rounded-full transition-transform ${checked ? 'translate-x-4' : ''}`}
          />
        </button>
      }
    />
  )
}

/** The account stays out of view until asked for: it is personal and rarely needed. */
function AccountReveal({ account }: { readonly account: string | null }) {
  const [revealedAccount, setRevealedAccount] = useState<string | null>(null)
  if (account === null) return <span>Authenticated</span>
  const revealed = isAccountRevealed(revealedAccount, account)
  return (
    <span>
      Authenticated as{' '}
      {revealed ? (
        <span className="text-foreground font-medium">{account}</span>
      ) : (
        <button
          type="button"
          onClick={() => setRevealedAccount(account)}
          className="text-foreground focus-visible:ring-ring/50 rounded underline underline-offset-2 outline-none focus-visible:ring-3"
        >
          Click to reveal account
        </button>
      )}
    </span>
  )
}

/** Settings › Workspace › Source control: Git and GitHub detection and the preferences built on them. */
export function SourceControlPane(): React.JSX.Element {
  const discovery = useSourceControlDiscovery()
  const preferences = useSourceControlPreferences()
  const found = discovery.data
  const git = found?.git ?? null
  const github = found?.github ?? null

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <QueryErrorNotice error={discovery.error} hasData={discovery.data !== null} />

      <Section
        title="Version control"
        action={
          <TextTooltip
            label="Rescan Git and hosting integrations"
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Rescan"
                onClick={() => discovery.rescan()}
              >
                <ScanSearch />
              </Button>
            }
          />
        }
      >
        <div className="flex items-start gap-2.5 px-3 py-2.5">
          <StatusDot tone={gitTone(git)} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-foreground flex items-center gap-1.5 text-[12.5px] font-medium">
              Git
              {git?.version && <code className="bg-muted rounded px-1 py-0.5 text-[10.5px]">{git.version}</code>}
            </p>
            <p className="text-muted-foreground text-[11px]">{gitSummary(git)}</p>
          </div>
        </div>
      </Section>

      <Section title="Source control providers">
        <SettingRow
          id="settings-source-control-github"
          label="GitHub"
          resetLabel="Reset GitHub offering"
          onReset={
            preferences.githubOffered === DEFAULT_SOURCE_CONTROL_PREFERENCES.githubOffered
              ? undefined
              : preferences.resetGithubOffered
          }
          description={
            <span className="flex items-start gap-2">
              <StatusDot tone={githubTone(github?.cli ?? null)} />
              <span className="flex flex-col gap-1">
                {github?.version && (
                  <code className="bg-muted w-fit rounded px-1 py-0.5 text-[10.5px]">{github.version}</code>
                )}
                {github?.cli === 'ready' ? (
                  <AccountReveal account={github.account} />
                ) : github?.cli === 'unauthenticated' ? (
                  <span className="flex flex-col items-start gap-1">
                    <Badge variant="outline">Not authenticated</Badge>
                    <span>
                      Sign in with <code className="bg-muted rounded px-1 py-0.5">gh auth login</code> on this computer,
                      then rescan.
                    </span>
                  </span>
                ) : (
                  <span>{githubSummary(github?.cli ?? null)}</span>
                )}
              </span>
            </span>
          }
          control={
            <Switch
              id="settings-source-control-github"
              checked={preferences.githubOffered}
              label="Offer GitHub"
              tooltip="Offer when adding or publishing a project"
              onChange={preferences.setGithubOffered}
            />
          }
        />
      </Section>

      <Section title="Pull requests">
        <SettingRow
          id="settings-source-control-merge-method"
          label="Default merge method"
          description="The method a pull request merge starts with. You can still change it for each merge."
          onReset={
            preferences.mergeMethod === DEFAULT_SOURCE_CONTROL_PREFERENCES.mergeMethod
              ? undefined
              : preferences.resetMergeMethod
          }
          control={
            <Select
              value={preferences.mergeMethod}
              onValueChange={value => {
                if (value) preferences.setMergeMethod(value as MergeMethod)
              }}
            >
              <SelectTrigger id="settings-source-control-merge-method" size="sm" className="w-48 text-[12.5px]">
                <SelectValue>
                  {MERGE_METHOD_OPTIONS.find(option => option.value === preferences.mergeMethod)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MERGE_METHOD_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </Section>
    </div>
  )
}
