/** The Task title a prompt seeds: its first line, at most 100 characters, or `New Task` when the prompt is blank. */
export function taskTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  return firstLine.slice(0, 100) || 'New Task'
}
