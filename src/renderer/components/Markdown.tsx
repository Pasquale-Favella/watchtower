import 'katex/dist/katex.min.css'

import { createCodePlugin } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import { createMermaidPlugin } from '@streamdown/mermaid'
import { memo } from 'react'
import { type Components, defaultRemarkPlugins, Streamdown, type StreamdownProps } from 'streamdown'

import { remarkFileLinks } from './markdown/markdown-links'
import { markdownRehypePlugins } from './markdown/markdown-rehype'
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
      rehypePlugins={markdownRehypePlugins}
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
