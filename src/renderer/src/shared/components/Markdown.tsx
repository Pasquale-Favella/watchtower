import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Harness links open in the default browser through the guarded
 *  `open-external` IPC channel (http/https only, main-process enforced) — the
 *  same pattern the PR rows use. Without this, a bare <a href> would navigate
 *  the Electron window away from the app. */
function openExternalLink(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault()
  event.stopPropagation()
  void window.api.openExternal(url)
}

/** Renders harness markdown to HTML. The surrounding surface applies
 *  shadcn/typeset typography (wrap with `.typeset`); the component itself
 *  carries no classes so the typeset container styles everything inside. */
export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        // Anchor onClick override type is supplied by react-markdown; keep the
        // rest of the anchor props (href, title) untouched.
        a: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => (
          <a
            {...props}
            onClick={event => {
              if (props.href) openExternalLink(event, props.href)
            }}
          />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
