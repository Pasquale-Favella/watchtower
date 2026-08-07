import WatchtowerLogo from '@/assets/images/watchtower-logo.json'
import { GenIcon, type IconBaseProps, type IconTree } from 'react-icons'

/** The logo art occupies only ~31% × ~53% of its 1024² source canvas (paths
 * span x∈[336,658], y∈[208,748]), so the raw JSON renders as a tiny mark
 * floating in an empty icon box. Crop the viewBox to the artwork — with a
 * small optical pad so the mark never touches the edge — here, once, so every
 * usage renders the logo at full size. */
const CROPPED_VIEWBOX = '320.1 191.9 354.0 572.0'

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
