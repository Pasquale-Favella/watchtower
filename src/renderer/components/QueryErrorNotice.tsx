import { ErrorPanel } from '@/components/ErrorPanel'

/** Shows a blocking error before the first payload and a small notice when stale data remains visible. */
export function QueryErrorNotice({
  error,
  hasData,
}: {
  error: string | null
  hasData: boolean
}): React.JSX.Element | null {
  if (!error) return null
  if (!hasData) return <ErrorPanel message={error} />

  return (
    <p role="status" className="text-destructive text-[11px]">
      Refresh failed: {error}
    </p>
  )
}
