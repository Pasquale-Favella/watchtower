import { useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button.js'
import { useErrorToast } from '@/renderer/features/workspace/error-toast.js'

import { useSaveSkill } from './coach-chat-hooks.js'

export function SaveSkillButton({ markdown }: { readonly markdown: string }): React.JSX.Element {
  const execute = useSaveSkill()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  useErrorToast('coach:save-skill', "Couldn't save the skill", error)

  async function save(): Promise<void> {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown.trimStart())?.[1]
    const name = frontmatter?.match(/^name:[ \t]*(.+)$/m)?.[1]?.trim() ?? 'skill'
    try {
      const result = await execute({ payload: { name, content: markdown } })
      if (!result.ok && result.error !== 'cancelled') setError(result.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The skill could not be saved.')
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  return (
    <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={save}>
      Save…
    </Button>
  )
}
