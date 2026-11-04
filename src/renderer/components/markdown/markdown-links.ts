import { markdownFilePath } from './markdown-url'

interface MarkdownNode {
  readonly type: string
  url?: string
  readonly children?: readonly MarkdownNode[]
}

function normalizeFileLinks(node: MarkdownNode): void {
  if (
    node.type === 'link' &&
    node.url &&
    !node.url.includes('/') &&
    /:\d+(?::\d+)?$/.test(node.url) &&
    markdownFilePath(node.url)
  ) {
    node.url = `./${node.url}`
  }
  for (const child of node.children ?? []) normalizeFileLinks(child)
}

export function remarkFileLinks(): (tree: MarkdownNode) => void {
  return normalizeFileLinks
}
