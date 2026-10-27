import { normalizeChatName } from '../../../shared/chat-name.js'
import { now, optionalTrimmedString, type JsonRecord } from '../runtimeCommon.js'
import type { SessionCommandRuntimeHost } from './sessionCommandRuntime.js'

type RenameHost = Pick<SessionCommandRuntimeHost, 'state' | 'getState' | 'appendKernelEvent' | 'touch' | 'broadcast'>

/** Rename presentation only; a running provider keeps its current turn and workspace. */
export function renameChat(host: RenameHost, input: JsonRecord, ctx: JsonRecord) {
  if (ctx.actor?.kind !== 'human') throw new Error('Only a human can rename chats.')
  const sessionId = optionalTrimmedString(input.sessionId)
  if (!sessionId) throw new Error('Choose a chat to rename.')
  const state = host.state()
  const session = state.sessions[sessionId]
  const workspace = state.collaborationSessions?.[sessionId]
  if (!session && !workspace) throw new Error(`Unknown chat: ${sessionId}`)
  const label = normalizeChatName(input.label)
  const ts = now()
  if (session) {
    session.label = label
    session.labelIsCustom = true
    session.updatedAt = ts
    for (const node of state.nodes) if (node.sessionId === sessionId || node.nodeId === sessionId) node.label = label
  } else {
    workspace.title = label
    workspace.updatedAt = ts
  }
  host.appendKernelEvent('chat.renamed', { sessionId, label }, ctx)
  host.touch()
  host.broadcast({ type: 'runtime.state', state: host.getState() })
  return { ok: true, state: host.getState() }
}
