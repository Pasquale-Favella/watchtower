import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import type { WebContents } from 'electron'

import { workspacePreviewWindow } from '@/platform/electron/main/preview/electron-preview.js'
import type { WorkspacePreviewManager } from '@/platform/electron/main/preview/preview-manager.js'
import { WorkspaceHost } from '@/platform/electron/main/workspace/host.js'
import {
  workspacePreviewMessages,
  WorkspacePreviewRpcError,
  WorkspacePreviewRpcGroup,
} from '@/shared/rpc/workspace-preview.js'
import { taskIdSchema } from '@/shared/schemas/workspace.js'
import type { WorkspacePreviewState } from '@/shared/schemas/workspace-preview.js'

function failure(error: unknown): WorkspacePreviewRpcError {
  return Schema.is(WorkspacePreviewRpcError)(error)
    ? error
    : new WorkspacePreviewRpcError({ code: 'failed', message: workspacePreviewMessages.failed })
}

export function workspacePreviewHandlers(manager: WorkspacePreviewManager, sender: WebContents) {
  const host = () => workspacePreviewWindow(manager, sender)
  return WorkspacePreviewRpcGroup.toLayer({
    'preview:pick': request => Effect.tryPromise({ try: () => manager.pick(host(), request), catch: failure }),
    'preview:cancelPick': request => Effect.try({ try: () => manager.cancelPick(host(), request), catch: failure }),
    'preview:configure': request =>
      Effect.tryPromise({ try: () => manager.configure(host(), request), catch: failure }),
    'preview:bind': request =>
      Effect.gen(function* () {
        const taskId = yield* Schema.decodeUnknownEffect(taskIdSchema)(request.taskId)
        const workspace = yield* WorkspaceHost
        yield* workspace.store.readTaskDetail(taskId, { limit: 1 })
        yield* Effect.try({ try: () => manager.bind(host(), request.ownerKey, taskId), catch: failure })
      }).pipe(Effect.mapError(failure)),
    'preview:tabs': request => Effect.try({ try: () => manager.list(host(), request.ownerKey), catch: failure }),
    'preview:tabEvents': request =>
      Stream.callback<readonly WorkspacePreviewState[], WorkspacePreviewRpcError>(
        queue =>
          Effect.acquireRelease(
            Effect.try({
              try: () =>
                manager.subscribeTabs(host(), request.ownerKey, tabs => {
                  Queue.offerUnsafe(queue, tabs)
                }),
              catch: failure,
            }),
            unsubscribe => Effect.sync(unsubscribe),
          ),
        { bufferSize: 1, strategy: 'sliding' },
      ),
    'preview:capture': request => Effect.tryPromise({ try: () => manager.capture(host(), request), catch: failure }),
    'preview:focusApp': () => Effect.try({ try: () => sender.focus(), catch: failure }),
    'preview:open': request => Effect.try({ try: () => manager.open(host(), request), catch: failure }),
    'preview:navigate': request => Effect.try({ try: () => manager.navigate(host(), request), catch: failure }),
    'preview:command': request => Effect.tryPromise({ try: () => manager.command(host(), request), catch: failure }),
    'preview:layout': request =>
      Effect.try({
        try: () => {
          const zoom = sender.getZoomFactor()
          const bounds = request.bounds
          manager.layout(host(), {
            ...request,
            bounds: {
              x: bounds.x * zoom,
              y: bounds.y * zoom,
              width: bounds.width * zoom,
              height: bounds.height * zoom,
            },
          })
        },
        catch: failure,
      }),
    'preview:close': request => Effect.try({ try: () => manager.close(host(), request), catch: failure }),
    'preview:adopt': request =>
      Effect.try({ try: () => manager.adoptOwner(host(), request.ownerKey, request.nextOwnerKey), catch: failure }),
    'preview:events': request =>
      Stream.callback<WorkspacePreviewState, WorkspacePreviewRpcError>(
        queue =>
          Effect.acquireRelease(
            Effect.try({
              try: () =>
                manager.subscribe(host(), request, state => {
                  Queue.offerUnsafe(queue, state)
                }),
              catch: failure,
            }),
            unsubscribe => Effect.sync(unsubscribe),
          ),
        { bufferSize: 1, strategy: 'sliding' },
      ),
  })
}
