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
import { TextTooltip } from '@/renderer/components/ui/tooltip'

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
        <TextTooltip
          label="Wrap code"
          trigger={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Wrap code"
              aria-pressed={wrap}
              onClick={() => setWrap(value => !value)}
            >
              <WrapTextIcon />
            </Button>
          }
        />
        <TextTooltip
          label="Copy code"
          trigger={
            <span className="inline-flex">
              <CodeBlockCopyButton
                aria-label="Copy code"
                title={undefined}
                className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
              />
            </span>
          }
        />
        <TextTooltip
          label="Download code"
          trigger={
            <span className="inline-flex">
              <CodeBlockDownloadButton
                language={language}
                aria-label="Download code"
                title={undefined}
                className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
              />
            </span>
          }
        />
      </CodeBlock>
    </div>
  )
}
