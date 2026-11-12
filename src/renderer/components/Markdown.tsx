import 'katex/dist/katex.min.css'

import { createCodePlugin } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import { createMermaidPlugin } from '@streamdown/mermaid'
import { memo } from 'react'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import {
  type Components,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from 'streamdown'

import { remarkFileLinks } from './markdown/markdown-links'
import { markdownUrlTransform } from './markdown/markdown-url'
import { MarkdownCode, MarkdownInlineCode } from './markdown/MarkdownCode'
import { MarkdownImage, MarkdownLink } from './markdown/MarkdownMedia'

const plugins = {
  code: createCodePlugin(),
  math: createMathPlugin({ singleDollarTextMath: true }),
  mermaid: createMermaidPlugin({ config: { securityLevel: 'strict', startOnLoad: false } }),
}
const promptReferencePlugins = {
  ...plugins,
  math: createMathPlugin({ singleDollarTextMath: false }),
}

const components: Components = {
  a: MarkdownLink,
  code: MarkdownCode,
  inlineCode: MarkdownInlineCode,
  img: MarkdownImage,
}

const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkFileLinks]

const rehypePlugins: NonNullable<StreamdownProps['rehypePlugins']> = [
  defaultRehypePlugins.raw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      clobberPrefix: 'markdown-',
      protocols: {
        ...defaultSchema.protocols,
        src: [...(defaultSchema.protocols?.src ?? []), 'data', 'file', ...'abcdefghijklmnopqrstuvwxyz'],
        href: [...(defaultSchema.protocols?.href ?? []), 'file', ...'abcdefghijklmnopqrstuvwxyz'],
      },
      attributes: { ...defaultSchema.attributes, code: [...(defaultSchema.attributes?.code ?? []), 'metastring'] },
    },
  ],
]

export interface MarkdownProps {
  children: string
  streaming?: boolean
  remarkPlugins?: NonNullable<StreamdownProps['remarkPlugins']>
  components?: Components
  singleDollarMath?: boolean
}

export const Markdown = memo(function Markdown({
  children,
  streaming = false,
  remarkPlugins: additionalRemarkPlugins = [],
  components: additionalComponents,
  singleDollarMath = true,
}: MarkdownProps): React.JSX.Element {
  return (
    <Streamdown
      className="watchtower-markdown"
      mode="streaming"
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      plugins={singleDollarMath ? plugins : promptReferencePlugins}
      rehypePlugins={rehypePlugins}
      remarkPlugins={[...remarkPlugins, ...additionalRemarkPlugins]}
      components={{ ...components, ...additionalComponents }}
      urlTransform={markdownUrlTransform}
      skipHtml
      lineNumbers={false}
    >
      {children}
    </Streamdown>
  )
})
