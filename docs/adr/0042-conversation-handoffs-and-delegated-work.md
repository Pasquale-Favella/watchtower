# Keep Conversation identity across Harness Connection changes

A Conversation can contain Runs from several Harness Connections. Changing the connection starts a new native Agent Session and supplies bounded prior Conversation context to its first Run; a durable handoff event records the source, target and context limit so history can explain the transition. A same-connection model change stays on the native Agent Session, while `/clear` starts a fresh session without a handoff. Side chats remain separate linked Tasks, and Harness-native delegated agents remain child activity within their parent Run. This preserves Conversation history and native session ownership without treating a side chat or delegated agent as a resumed session.

Amendment (ADR 0044): agent-started children are Delegated Tasks linked as Tasks; native delegated agents remain child activity within their parent Run.
