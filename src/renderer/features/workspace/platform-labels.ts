const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent

export const isMac = userAgent.includes('Mac')
export const fileManagerName = userAgent.includes('Windows') ? 'Explorer' : isMac ? 'Finder' : 'Files'
export const submitModifier = isMac ? '⌘' : 'Ctrl'
