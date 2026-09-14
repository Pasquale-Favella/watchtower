/** EfficiencyGauge — a semicircular one-shot dial (track + value arc +
 * needle + hub) drawn as deterministic SVG: center, radius and angles are
 * fixed, so the arc can never clip or drift out of alignment the way a
 * chart-library pie with implicit centering does. A native `<title>`
 * names the value on hover. `value` is 0..1, null renders the muted
 * track only. */
export function EfficiencyGauge({ value }: { value: number | null }) {
  const pct = value === null ? null : Math.min(1, Math.max(0, value))
  const cx = 80
  const cy = 86
  const r = 62
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`

  const needleLen = 44
  const angleDeg = pct === null ? 180 : 180 - pct * 180
  const angleRad = (angleDeg * Math.PI) / 180
  const nx = cx + needleLen * Math.cos(angleRad)
  const ny = cy - needleLen * Math.sin(angleRad)

  return (
    <div className="w-[160px] shrink-0" role="img" aria-label={pct === null ? 'One-shot rate unavailable' : `One-shot rate ${Math.round(pct * 100)} percent`}>
      <svg viewBox="0 0 160 100" className="h-auto w-full" aria-hidden="true">
        <title>{pct === null ? 'One-shot rate unavailable' : `One-shot success rate: ${Math.round(pct * 100)}%`}</title>
        {/* Track */}
        <path d={arc} fill="none" stroke="var(--muted)" strokeWidth={15} strokeLinecap="round" />
        {/* Value */}
        {pct !== null && pct > 0.005 && (
          <path
            d={arc}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={15}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${pct * 100} 100`}
          />
        )}
        {/* Needle + hub */}
        {pct !== null && (
          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--foreground)" strokeWidth={3} strokeLinecap="round" />
        )}
        <circle cx={cx} cy={cy} r={6.5} fill="var(--foreground)" stroke="var(--card)" strokeWidth={3} />
      </svg>
    </div>
  )
}
