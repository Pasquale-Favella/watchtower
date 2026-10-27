import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { parsePayload } from '@/shared/lib/contract-decoder'

import type { Section } from '../../../shared/schemas/navigation.js'
import type { OrbPanelRequest, OrbPlacement } from '../../../shared/schemas/orb.js'
import { orbPlacementSchema } from '../../../shared/schemas/orb.js'

const nullablePlacementSchema = Schema.NullOr(orbPlacementSchema)

export class OrbShellError extends Data.TaggedError('OrbShellError')<{
  readonly operation: 'orb:placement:get' | 'orb:panel:request'
  readonly message: string
}> {}

type NativeOrbShell = typeof window.api.orb

export interface OrbShellService {
  readonly getOrbPlacement: () => Effect.Effect<OrbPlacement | null, OrbShellError>
  readonly requestOrbPanel: (request: OrbPanelRequest) => Effect.Effect<OrbPlacement | null, OrbShellError>
}

export class OrbShell extends Context.Service<OrbShell, OrbShellService>()('watchtower/orb/OrbShell') {
  static readonly layer = Layer.sync(OrbShell, () => createOrbShell(window.api.orb))
}

function decodePlacement(
  operation: OrbShellError['operation'],
  value: unknown,
): Effect.Effect<OrbPlacement | null, OrbShellError> {
  const result = parsePayload(nullablePlacementSchema, 'orb placement', value)
  return result.ok ? Effect.succeed(result.data) : Effect.fail(new OrbShellError({ operation, message: result.error }))
}

export function createOrbShell(shell: Pick<NativeOrbShell, 'getPlacement' | 'requestPanel'>): OrbShellService {
  return {
    getOrbPlacement: () =>
      Effect.tryPromise({
        try: () => shell.getPlacement(),
        catch: () => new OrbShellError({ operation: 'orb:placement:get', message: 'Unable to read orb placement.' }),
      }).pipe(Effect.flatMap(value => decodePlacement('orb:placement:get', value))),
    requestOrbPanel: request =>
      Effect.tryPromise({
        try: () => shell.requestPanel(request),
        catch: () => new OrbShellError({ operation: 'orb:panel:request', message: 'Unable to update the orb panel.' }),
      }).pipe(Effect.flatMap(value => decodePlacement('orb:panel:request', value))),
  }
}

export const orbControls = {
  dragStart: (): void => window.api.orb.dragStart(),
  dragMove: (dx: number, dy: number): void => window.api.orb.dragMove(dx, dy),
  dragEnd: (): void => window.api.orb.dragEnd(),
  openApp: (section?: Section): void => window.api.orb.openApp(section),
  hide: (): void => window.api.orb.hide(),
  quit: (): void => window.api.orb.quit(),
  panelPainted: (): void => window.api.orb.panelPainted(),
  panelDataReady: (): void => window.api.orb.panelDataReady(),
}
