import { WrapTextIcon } from 'lucide-react'
import { type HTMLAttributes, useState } from 'react'
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  defaultComponents,
  type ExtraProps,
  useIsCodeFenceIncomplete,
} from 'streamdown'

import { Button, buttonVariants } from '@/renderer/components/ui/button'

type CodeProps = HTMLAttributes<HTMLElement> & ExtraProps

export function MarkdownInlineCode({ children, className }: CodeProps): React.JSX.Element {
  return <code className={className}>{children}</code>
}

export function MarkdownCode(props: CodeProps): React.JSX.Element {
  const { children, className } = props
  const [wrap, setWrap] = useState(false)
  const incomplete = useIsCodeFenceIncomplete()
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1] ?? 'text'

  if (language === 'mermaid') return <defaultComponents.code {...props} />

  return (
    <div className="not-typeset markdown-code" data-wrap={wrap}>
      <CodeBlock code={String(children ?? '')} language={language} isIncomplete={incomplete}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Wrap code"
          title="Wrap code"
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          <WrapTextIcon />
        </Button>
        <CodeBlockCopyButton
          aria-label="Copy code"
          title="Copy code"
          className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
        />
        <CodeBlockDownloadButton
          language={language}
          aria-label="Download code"
          title="Download code"
          className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
        />
      </CodeBlock>
    </div>
  )
}
