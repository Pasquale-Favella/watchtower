import { motionClass } from '@/shared/lib/motion'

/** Three dots that breathe in sequence after the status text. */
export function Ellipsis() {
  return (
    <span aria-hidden className="ml-px inline-flex gap-px">
      {[0, 1, 2].map(i => (
        <span key={i} className={motionClass('', 'animate-pulse')} style={{ animationDelay: `${i * 200}ms` }}>
          .
        </span>
      ))}
    </span>
  )
}
