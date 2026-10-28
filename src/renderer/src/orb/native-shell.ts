import * as Effect from 'effect/Effect'

import type { OrbCommand } from '../../../shared/rpc/shell.js'
import type { Section } from '../../../shared/schemas/navigation.js'
import { registry } from '../app/renderer-runtime.js'
import { BeaconRoleClient } from './beacon-role-client.js'
import { PanelRoleClient } from './panel-role-client.js'

const beaconCommand = BeaconRoleClient.runtime.fn<OrbCommand>()(
  command => Effect.flatMap(BeaconRoleClient, rpc => rpc('orb:command', command, { discard: true })),
  { concurrent: true },
)
const panelCommand = PanelRoleClient.runtime.fn<OrbCommand>()(
  command => Effect.flatMap(PanelRoleClient, rpc => rpc('orb:command', command, { discard: true })),
  { concurrent: true },
)
const commandAtom = globalThis.location?.pathname.endsWith('/orb-panel.html') ? panelCommand : beaconCommand
const send = (command: OrbCommand): void => registry.set(commandAtom, command)

export const orbControls = {
  dragStart: (): void => send({ _tag: 'DragStart' }),
  dragMove: (dx: number, dy: number): void => send({ _tag: 'DragMove', dx, dy }),
  dragEnd: (): void => send({ _tag: 'DragEnd' }),
  openApp: (section?: Section): void => send({ _tag: 'OpenApp', section }),
  hide: (): void => send({ _tag: 'Hide' }),
  quit: (): void => send({ _tag: 'Quit' }),
  panelPainted: (): void => send({ _tag: 'PanelPainted' }),
  panelDataReady: (): void => send({ _tag: 'PanelDataReady' }),
}
