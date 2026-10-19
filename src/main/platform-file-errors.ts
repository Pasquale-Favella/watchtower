import * as Cause from 'effect/Cause'
import * as PlatformError from 'effect/PlatformError'

/** Normalize only a nonempty cause made entirely of official platform errors. */
export function mapPlatformCloseCause<E, E2>(
  cause: Cause.Cause<E>,
  makeError: (error: PlatformError.PlatformError) => E2,
): Cause.Cause<E2> | null {
  if (
    cause.reasons.length === 0 ||
    !cause.reasons.every(reason => Cause.isDieReason(reason) && PlatformError.isPlatformError(reason.defect))
  ) {
    return null
  }

  return Cause.fromReasons(
    cause.reasons.flatMap(reason =>
      Cause.isDieReason(reason) && PlatformError.isPlatformError(reason.defect)
        ? [Cause.makeFailReason(makeError(reason.defect))]
        : [],
    ),
  )
}
