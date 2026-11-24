export function renderedFileKind(path: string): 'markdown' | 'mermaid' | 'html' | 'table' | 'svg' | null {
  if (/\.(?:md|mdx|markdown|mdown|mkd)$/i.test(path)) return 'markdown'
  if (/\.(?:mmd|mermaid)$/i.test(path)) return 'mermaid'
  if (/\.html?$/i.test(path)) return 'html'
  if (/\.(?:csv|tsv)$/i.test(path)) return 'table'
  if (/\.svg$/i.test(path)) return 'svg'
  return null
}
