import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

export interface ErrorToastAction {
  readonly label: string
  readonly onClick: () => void
}

/** How long an error toast that carries a recovery action stays up, so the user can reach the button. */
const ACTION_DURATION_MS = 10_000

/**
 * Raises one error toast for a failed user action. The stable `id` makes a repeat of the same failure update the
 * visible toast in place instead of stacking duplicates.
 */
export function showErrorToast(
  id: string,
  title: string,
  description?: string | null,
  action?: ErrorToastAction | undefined,
): void {
  toast.error(title, {
    id,
    ...(description ? { description } : {}),
    ...(action ? { action: { label: action.label, onClick: action.onClick }, duration: ACTION_DURATION_MS } : {}),
  })
}

/**
 * Mirrors an error held in component state into a toast: it appears when `error` becomes a message and is dismissed
 * when it clears. The action callback is read at click time, so a changing closure does not re-raise the toast.
 */
export function useErrorToast(
  id: string,
  title: string,
  error: string | null | undefined,
  action?: ErrorToastAction | undefined,
): void {
  const actionRef = useRef(action)
  useEffect(() => {
    actionRef.current = action
  })
  const shown = useRef(false)
  const actionLabel = action?.label
  useEffect(() => {
    if (!error) {
      if (shown.current) {
        shown.current = false
        toast.dismiss(id)
      }
      return
    }
    shown.current = true
    showErrorToast(
      id,
      title,
      error,
      actionLabel === undefined ? undefined : { label: actionLabel, onClick: () => actionRef.current?.onClick() },
    )
  }, [id, title, error, actionLabel])
  // A toast must not outlive the view whose callback it carries.
  useEffect(
    () => () => {
      if (shown.current) {
        shown.current = false
        toast.dismiss(id)
      }
    },
    [id],
  )
}
