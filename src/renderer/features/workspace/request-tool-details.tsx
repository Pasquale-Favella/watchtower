import type { AgentRequest } from '@/shared/schemas/execution.js'

import { FileChangesBlock } from './timeline/FileChangesBlock.js'

export function RequestToolDetails({ request }: { readonly request: AgentRequest }): React.JSX.Element | null {
  const tool = request.tool
  const hasMetadata = Boolean(
    request.toolCallId ||
    tool?.category ||
    tool?.command ||
    tool?.cwd ||
    tool?.description ||
    (tool?.paths?.length ?? 0) > 0 ||
    (tool?.changes?.length ?? 0) > 0 ||
    tool?.url ||
    tool?.exitCode !== undefined ||
    tool?.durationMs !== undefined,
  )
  const hasTechnicalDetails = Boolean(
    request.toolCallId || tool?.category || tool?.url || tool?.exitCode !== undefined || tool?.durationMs !== undefined,
  )
  if (!hasMetadata) return null

  return (
    <div className="space-y-2 rounded border px-3 py-2 text-xs">
      <div className="max-h-32 space-y-2 overflow-y-auto">
        {tool?.description && <p className="break-words whitespace-pre-wrap">{tool.description}</p>}
        {tool?.command && (
          <div>
            <p className="text-muted-foreground mb-1">Command</p>
            <code className="block break-all whitespace-pre-wrap">{tool.command}</code>
          </div>
        )}
        {tool?.cwd && (
          <p className="break-all">
            <span className="text-muted-foreground">Working directory </span>
            <code>{tool.cwd}</code>
          </p>
        )}
        {tool?.paths?.length && !tool.changes?.length ? (
          <ul className="text-muted-foreground space-y-1 font-mono" aria-label="Referenced files">
            {tool.paths.map(path => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
        ) : null}
        {tool?.changes?.length ? <FileChangesBlock changes={tool.changes} /> : null}
      </div>
      {hasTechnicalDetails && (
        <details className="text-muted-foreground text-[11px]">
          <summary className="cursor-pointer">Details</summary>
          <dl className="mt-1 space-y-1">
            {request.toolCallId && (
              <div>
                <dt>Tool call</dt>
                <dd className="font-mono break-all">{request.toolCallId}</dd>
              </div>
            )}
            {tool?.category && (
              <div>
                <dt>Category</dt>
                <dd>{tool.category}</dd>
              </div>
            )}
            {tool?.url && (
              <div>
                <dt>URL</dt>
                <dd className="break-all">{tool.url}</dd>
              </div>
            )}
            {tool?.exitCode !== undefined && (
              <div>
                <dt>Exit code</dt>
                <dd>{tool.exitCode}</dd>
              </div>
            )}
            {tool?.durationMs !== undefined && (
              <div>
                <dt>Duration</dt>
                <dd>{tool.durationMs} ms</dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </div>
  )
}
