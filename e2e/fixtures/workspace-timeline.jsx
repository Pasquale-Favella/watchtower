/* global document, window */
import './workspace-timeline.css'

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Markdown } from '@/renderer/components/Markdown'
import { handleTimelinePageKey } from '@/renderer/features/workspace/timeline/scroll-keys'
import { TimelineScroller } from '@/renderer/features/workspace/timeline/TimelineScroller'

function message(index) {
  const content =
    index % 3 === 0 ? '\n\n```ts\nconst value = 42\n```' : '\n\n| Name | Value |\n| --- | --- |\n| Example | 42 |'
  const link = index === 299 ? '\n\n[Reference](https://example.invalid/reference)' : ''
  return {
    id: `message-${index}`,
    text: `Message ${index}\n\n${'A paragraph with variable height. '.repeat((Math.abs(index) % 7) + 1)}${content}${link}`,
  }
}

function rowType() {
  return 'message'
}

function Fixture() {
  const [rows, setRows] = useState(() => Array.from({ length: 300 }, (_, index) => message(index)))
  const [conversation, setConversation] = useState('first')
  const [streaming, setStreaming] = useState(false)
  const [chunks, setChunks] = useState(0)
  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => {
      setRows(current =>
        current.map((row, index) =>
          index === current.length - 1
            ? { ...row, text: `${row.text}\n\nStreaming output with **formatted text**.` }
            : row,
        ),
      )
      setChunks(current => current + 1)
    }, 40)
    return () => window.clearInterval(timer)
  }, [streaming])
  return (
    <main className="flex h-dvh flex-col">
      <div className="flex shrink-0 gap-4 p-2">
        <button onClick={() => setStreaming(current => !current)}>
          {streaming ? 'Stop streaming' : 'Start streaming'}
        </button>
        <button
          onClick={() =>
            setRows(current => [...Array.from({ length: 80 }, (_, index) => message(-80 + index)), ...current])
          }
        >
          Prepend history
        </button>
        <button onClick={() => setConversation(current => (current === 'first' ? 'second' : 'first'))}>
          Switch conversation
        </button>
        <output aria-label="Chunks">{chunks}</output>
      </div>
      <TimelineScroller
        key={conversation}
        conversationId={conversation}
        rows={conversation === 'first' ? rows : [message(1000)]}
        getRowType={rowType}
        renderRow={row => (
          <div className="typeset">
            <Markdown>{row.text}</Markdown>
          </div>
        )}
      />
      <textarea aria-label="Prompt" className="h-16 shrink-0" onKeyDown={handleTimelinePageKey} />
    </main>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
)
