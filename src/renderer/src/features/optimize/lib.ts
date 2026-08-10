import type { Impact, HealthGrade } from '../../../../shared/schemas/optimize.js'

/** Accent-tinted dot color for each severity (ADR 0008). */
export function impactDot(impact: Impact): string {
  switch (impact) {
    case 'high': return 'bg-destructive'
    case 'medium': return 'bg-warning'
    case 'low': return 'bg-muted-foreground'
  }
}

/** Health grade → text color token (ADR 0008). */
export function healthClass(grade: HealthGrade): string {
  switch (grade) {
    case 'A': return 'text-success'
    case 'B': return 'text-success'
    case 'C': return 'text-warning'
    case 'D': return 'text-warning'
    case 'F': return 'text-destructive'
  }
}

/** Trend badge label; `null` means not enough signal to judge. */
export function trendLabel(trend: 'active' | 'improving' | null): string {
  if (trend === 'improving') return 'improving'
  if (trend === 'active') return 'active'
  return 'no signal'
}
