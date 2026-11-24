import { useEffect, useState } from 'react'

export function useCodeTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

export const REVIEW_CODE_CSS = `
:host { --diffs-font-family: var(--font-mono); --diffs-font-size: 12px; --diffs-line-height: 20px; }
[data-diffs-header], [data-diff], [data-file], [data-virtualizer-buffer] {
  --diffs-bg: var(--background) !important;
  --diffs-light-bg: var(--background) !important;
  --diffs-dark-bg: var(--background) !important;
  --diffs-bg-context-override: var(--background);
  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-separator-override: var(--muted);
  --diffs-bg-hover-override: var(--muted);
  --diffs-bg-search-match-override: color-mix(in srgb, var(--warning) 35%, transparent);
  --diffs-bg-search-match-current-override: color-mix(in srgb, var(--primary) 40%, transparent);
  --diffs-header-font-family: var(--font-sans);
  background-color: var(--background) !important;
  color: var(--foreground) !important;
}
[data-diff-type="split"][data-overflow="wrap"] { --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr); }
[data-diffs-header] { height: 32px; font-size: 11px; }
`

export function reviewVersion(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}
