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

  const preview = tool?.command ?? tool?.description ?? tool?.paths?.[0] ?? tool?.url
  const previewLabel = tool?.command ? 'Command' : tool?.paths?.length ? 'Files' : tool?.url ? 'URL' : 'Details'
  const hasPrimaryActionDetails = Boolean(tool?.command || tool?.changes?.length)

  return (
    <details open={hasPrimaryActionDetails} className="group/tool-details border-t pt-3 text-xs">
      <summary className="focus-visible:ring-ring flex cursor-pointer items-center gap-2 rounded-sm focus-visible:ring-2 focus-visible:outline-none">
        <span className="shrink-0 font-medium">Command and file details</span>
        {preview && (
          <span className="text-muted-foreground min-w-0 truncate font-mono group-open/tool-details:hidden">
            {previewLabel}: {preview}
          </span>
        )}
      </summary>
      <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
        {tool?.description && tool.description !== request.prompt && (
          <p className="break-words whitespace-pre-wrap">{tool.description}</p>
        )}
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
    </details>
  )
}
