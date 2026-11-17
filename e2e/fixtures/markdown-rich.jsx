/* global document */
import './markdown-rich.css'

import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Markdown } from '@/renderer/components/Markdown'
import { MarkdownNavigationContext } from '@/renderer/components/markdown/MarkdownNavigation'
import { Button } from '@/renderer/components/ui/button'

const initial = `A stable paragraph with [Reference](https://example.invalid/reference), **bold** and \`inline code\`.

| Name | Value |
| --- | --- |
| Example | 42 |

- [x] Completed task
- [ ] Pending task

Inline math $E = mc^2$.

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\`\`\`mermaid
graph LR
  A[Prompt] --> B[Answer]
\`\`\`

![Remote image](https://example.invalid/tracking.png)

![Pixel](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)

<script>globalThis.markdownExecuted = true</script>

[Unsafe](javascript:alert%281%29)

\`\`\`typescript
const greeting = "A very long line that should wrap only after the wrap control is pressed. A very long line that should wrap only after the wrap control is pressed."
`

function Fixture() {
  const [openedFile, setOpenedFile] = useState('')
  const [imageReads, setImageReads] = useState([])
  const [text, setText] = useState(initial)
  const [streaming, setStreaming] = useState(true)
  return (
    <div className="dark bg-background text-foreground min-h-screen p-6">
      <div className="mb-6 flex gap-2">
        <Button onClick={() => setText(value => `${value}const appended = 42\n`)}>Append text</Button>
        <Button
          onClick={() => {
            setText(value => `${value}\`\`\`\n\nFinished.`)
            setStreaming(false)
          }}
        >
          Finish streaming
        </Button>
      </div>
      <article className="typeset mx-auto max-w-3xl" aria-label="Markdown message">
        <Markdown streaming={streaming}>{text}</Markdown>
      </article>
      <MarkdownNavigationContext
        value={{
          workspacePath: 'C:/work/repo',
          openFile: setOpenedFile,
          loadImage: async path => {
            setImageReads(reads => [...reads, path])
            if (path === 'images/missing.png') return null
            return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
          },
        }}
      >
        <article className="typeset mx-auto mt-6 max-w-3xl" aria-label="References">
          <Markdown>{references}</Markdown>
        </article>
        <output aria-label="Opened file">{openedFile}</output>
        <output aria-label="Image reads">{imageReads.join(',')}</output>
      </MarkdownNavigationContext>
    </div>
  )
}

const references = `Read the [reference guide][guide] and its footnote[^detail].

Second paragraph. [Source file](src/app.ts:12), [Root source](README.md:12) and [Absolute source](file:///C:/work/repo/src/absolute.ts:8).

![Local chart](images/chart.png)

![Absolute chart](file:///C:/work/repo/images/absolute.png)

![Missing chart](images/missing.png)

![Outside chart](file:///C:/outside/chart.png)

![Unsafe chart](images/chart.svg)

[guide]: https://example.invalid/guide
[^detail]: A useful detail.`

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
)
