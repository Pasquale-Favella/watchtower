import { useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

import { useCheckoutActions } from '../checkout-actions/use-checkout-actions.js'

interface Props {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly selectedPath: string | null
  readonly onChanged: () => void
}

export function CheckoutChangeActions({ scope, revision, selectedPath, onChanged }: Props): React.JSX.Element {
  const actions = useCheckoutActions(scope, revision)
  const [message, setMessage] = useState('')
  const files = actions.status?.files ?? []
  const staged = files.filter(file => file.index !== ' ' && file.index !== '?')
  const unstaged = files.filter(file => file.workingTree !== ' ' || file.index === '?')
  const selected = files.find(file => file.path === selectedPath)
  const paths = (items: typeof files) => [
    ...new Set(items.flatMap(file => (file.previousPath ? [file.path, file.previousPath] : [file.path]))),
  ]
  const update = async (command: Promise<boolean>) => {
    if (await command) onChanged()
  }
  const disabled = actions.pending || !actions.status

  return (
    <div className="border-border space-y-2 border-b px-2.5 py-2 text-xs" aria-label="Git changes">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground mr-auto">
          {staged.length} staged · {unstaged.length} unstaged
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled || unstaged.length === 0 || actions.status?.truncated}
          onClick={() => {
            void update(actions.stage(paths(unstaged)))
          }}
        >
          Stage all
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled || staged.length === 0 || actions.status?.truncated}
          onClick={() => {
            void update(actions.unstage(paths(staged)))
          }}
        >
          Unstage all
        </Button>
      </div>
      {selected && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono" title={selected.path}>
            {selected.path}
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={disabled || !unstaged.includes(selected)}
            onClick={() => {
              void update(actions.stage(paths([selected])))
            }}
          >
            Stage file
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={disabled || !staged.includes(selected)}
            onClick={() => {
              void update(actions.unstage(paths([selected])))
            }}
          >
            Unstage file
          </Button>
        </div>
      )}
      <form
        className="flex items-center gap-1.5"
        onSubmit={event => {
          event.preventDefault()
          if (disabled || staged.length === 0 || !message.trim()) return
          void actions.commit(message.trim()).then(committed => {
            if (committed) {
              setMessage('')
              onChanged()
            }
          })
        }}
      >
        <input
          aria-label="Commit message"
          placeholder="Commit message"
          value={message}
          maxLength={4096}
          onChange={event => setMessage(event.target.value)}
          className="border-input bg-background focus-visible:ring-ring h-7 min-w-0 flex-1 rounded-md border px-2 outline-none focus-visible:ring-1"
        />
        <Button type="submit" size="xs" disabled={disabled || staged.length === 0 || !message.trim()}>
          Commit staged
        </Button>
      </form>
      {actions.error && (
        <p role="alert" className="text-destructive">
          {actions.error}
        </p>
      )}
      {actions.status?.truncated && (
        <p className="text-muted-foreground">
          File list is truncated. Select individual files to stage or unstage them.
        </p>
      )}
    </div>
  )
}
