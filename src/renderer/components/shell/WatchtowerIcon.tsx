import WatchtowerLogo from '@/renderer/assets/images/watchtower-logo.json'
import { GenIcon, type IconBaseProps, type IconTree } from 'react-icons'

/** The new artwork's viewBox `190 44 960 1008` hugs the mark with a small
 * optical pad (paths span x∈[210,1128], y∈[69,1021]), so — unlike the old
 * 1024² source canvas where the art floated in dead space — no cropping is
 * needed. Pin the viewBox here explicitly, mirroring what's baked into the
 * icon-tree JSON, so every usage renders the mark at full size and the box
 * never depends on the raw source framing. */
const CROPPED_VIEWBOX = '190 44 960 1008'

const iconTree: IconTree = {
  ...WatchtowerLogo,
  attr: { ...WatchtowerLogo.attr, viewBox: CROPPED_VIEWBOX },
}

/** The Watchtower brand mark, rendered through react-icons' `GenIcon` from the
 * raw icon-tree JSON in `assets/images` — the same pattern Launchpad uses for
 * its LaunchpadIcon. The JSON is already an icon tree (`{ tag, attr, child }`),
 * so no conversion is needed: props are plain `IconBaseProps` (size, className,
 * color, …) and the mark inherits `currentColor` for its fill. */
export const WatchtowerIcon = (props: IconBaseProps) => GenIcon(iconTree)(props)
