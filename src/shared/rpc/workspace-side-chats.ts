import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { taskIdSchema } from '@/shared/schemas/workspace.js'
import {
  createSideChatRequestSchema,
  sideChatBindingSchema,
  SideChatError,
  sideChatListSchema,
} from '@/shared/schemas/workspace-side-chats.js'
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const WorkspaceSideChatRpcGroup = RpcGroup.make(
  Rpc.make('sideChat:create', {
    payload: createSideChatRequestSchema,
    success: sideChatBindingSchema,
    error: SideChatError,
  }),
  Rpc.make('sideChat:get', { payload: Schema.Struct({ id }), success: sideChatBindingSchema, error: SideChatError }),
  Rpc.make('sideChat:list', {
    payload: Schema.Struct({ parentTaskId: taskIdSchema }),
    success: sideChatListSchema,
    error: SideChatError,
  }),
  Rpc.make('sideChat:bringBack', {
    payload: Schema.Struct({ id }),
    success: Schema.Struct({ text: Schema.String }),
    error: SideChatError,
  }),
)
