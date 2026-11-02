import { FolderOpen } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog'
import { Input } from '@/renderer/components/ui/input'
import type { WorkspaceProjectRegistration } from '@/shared/schemas/workspace-projects.js'

import { useRegisterProject } from './hooks.js'
import { useChooseWorkspaceProjectDirectory } from './project-directory-hooks.js'
import { useWorkspaceProjectDialog } from './use-project-dialog.js'
import { useWorkspaceNavigation } from './use-workspace-navigation.js'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed. Try again.'
}

function folderName(path: string): string {
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

export function WorkspaceProjectDialog(): React.JSX.Element {
  const dialog = useWorkspaceProjectDialog()
  const { selectProject } = useWorkspaceNavigation()
  const register = useRegisterProject()
  const directory = useChooseWorkspaceProjectDirectory()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const chooseDirectory = async () => {
    setError(null)
    try {
      const selected = await directory.execute()
      if (!selected) return
      setPath(selected)
      setName(current => (current.trim() ? current : folderName(selected)))
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      const receipt = await register.execute({ path: path.trim(), name: name.trim() })
      const project: WorkspaceProjectRegistration['project'] = receipt.project
      selectProject(project.id)
      dialog.showNotice(receipt.reused ? `Using the existing Project "${project.name}".` : `Added "${project.name}".`)
      setName('')
      setPath('')
      dialog.close()
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  return (
    <Dialog
      open={dialog.isOpen}
      onOpenChange={open => {
        if (open) dialog.open()
        else dialog.close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a Project</DialogTitle>
          <DialogDescription>Choose a local folder and give this Project a name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="space-y-3">
          <div className="space-y-1.5">
            <label className="block text-sm" htmlFor="workspace-project-name">
              Project name
            </label>
            <Input
              id="workspace-project-name"
              value={name}
              onChange={event => setName(event.target.value)}
              required
              maxLength={512}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm" htmlFor="workspace-project-path">
              Local checkout path
            </label>
            <div className="flex gap-2">
              <Input
                id="workspace-project-path"
                value={path}
                onChange={event => setPath(event.target.value)}
                required
                placeholder="C:\\src\\project"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void chooseDirectory()}
                disabled={directory.pending || register.pending}
                aria-label="Browse for project folder"
              >
                <FolderOpen />
                Browse
              </Button>
            </div>
          </div>
          {(error || directory.error) && (
            <p role="alert" className="text-destructive text-sm">
              {error ?? directory.error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={register.pending || directory.pending || !name.trim() || !path.trim()}>
              {register.pending ? 'Opening…' : 'Open Project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
