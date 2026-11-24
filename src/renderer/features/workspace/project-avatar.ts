const MONOGRAM_COLORS = [
  'text-blue-600 dark:text-blue-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-violet-600 dark:text-violet-400',
  'text-amber-600 dark:text-amber-400',
  'text-rose-600 dark:text-rose-400',
  'text-cyan-600 dark:text-cyan-400',
  'text-lime-600 dark:text-lime-400',
  'text-fuchsia-600 dark:text-fuchsia-400',
] as const

/** One or two letters from the Project name: the initials of its first two words, else its first character. */
export function projectMonogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].charAt(0).toLocaleUpperCase()
  return (words[0].charAt(0) + words[1].charAt(0)).toLocaleUpperCase()
}

/** A stable tint per Project, so the same Project reads the same in every row. */
export function projectMonogramColor(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return MONOGRAM_COLORS[Math.abs(hash) % MONOGRAM_COLORS.length]
}
