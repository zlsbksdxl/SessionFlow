import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatProject, ChatProjectSection } from '../../../shared/chat-projects.js'
import { chatNameMaxLength } from '../../../shared/chat-name.js'
import { diagnostic, isObject, now, optionalTrimmedString, type JsonRecord } from '../runtimeCommon.js'
import { applyChatProjectMove, prepareChatProjectMove, resolvedProjectDirectory, type ProjectHost } from './chatProjectRuntime.js'
import { normalizeWorkspaceConnection, workspaceConnectionKey } from '../workspace/remoteWorkspace.js'

function human(ctx: JsonRecord) {
  if (ctx.actor?.kind !== 'human') throw new Error('Only a human can manage chat projects.')
}

function label(value: unknown, kind: string) {
  const text = optionalTrimmedString(value)
  if (!text || text.length > chatNameMaxLength) throw new Error(`${kind} name must be between 1 and ${chatNameMaxLength} characters.`)
  return text
}

function projectFor(state: JsonRecord, projectId: unknown): ChatProject {
  const id = optionalTrimmedString(projectId)
  const project = id && Object.hasOwn(state.chatProjects ?? {}, id) ? state.chatProjects[id] : undefined
  if (!project) throw new Error('Choose an existing project.')
  return project
}

function canonical(value: string) {
  try { return fs.realpathSync(value) } catch { return path.resolve(value) }
}

function publish(host: ProjectHost, type: string, payload: JsonRecord, ctx: JsonRecord) {
  host.appendKernelEvent(type, payload, ctx)
  host.touch()
  host.broadcast({ type: 'runtime.state', state: host.getState() })
  return { ok: true, state: host.getState() }
}

function projectChats(state: JsonRecord, projectId: string) {
  const workspaces = Object.values(state.collaborationSessions ?? {}).filter((workspace: JsonRecord) => workspace.chatProjectId === projectId) as JsonRecord[]
  const memberIds = new Set(workspaces.flatMap((workspace) => workspace.members.map((member) => member.sessionId)))
  const sessions = Object.values(state.sessions).filter((session: JsonRecord) => session.chatProjectId === projectId || memberIds.has(session.sessionId)) as JsonRecord[]
  return { workspaces, sessions, memberIds }
}

export async function updateChatProject(host: ProjectHost, input: JsonRecord, ctx: JsonRecord) {
  human(ctx)
  const state = host.state()
  const project = projectFor(state, input.projectId)
  const next: ChatProject = { ...project }
  if (Object.hasOwn(input, 'connection')) {
    const connection = normalizeWorkspaceConnection(input.connection)
    if (connection) next.connection = connection
    else delete next.connection
  }
  const connection = normalizeWorkspaceConnection(next.connection)
  if (Object.hasOwn(input, 'label')) next.label = label(input.label, 'Project')
  if (Object.hasOwn(input, 'pinned')) {
    if (typeof input.pinned !== 'boolean') throw new Error('Project pin must be a boolean.')
    next.pinned = input.pinned
  }
  if (Object.hasOwn(input, 'sectionId')) {
    if (input.sectionId === null) delete next.sectionId
    else {
      const sectionId = optionalTrimmedString(input.sectionId)
      if (!sectionId || !Object.hasOwn(state.chatProjectSections ?? {}, sectionId)) throw new Error('Choose an existing project section.')
      next.sectionId = sectionId
    }
  }
  const plans: ReturnType<typeof prepareChatProjectMove>[] = []
  if (Object.hasOwn(input, 'cwd') || Object.hasOwn(input, 'connection')) {
    next.cwd = await resolvedProjectDirectory(Object.hasOwn(input, 'cwd') ? input.cwd : next.cwd, connection)
    if ((Object.values(state.chatProjects) as ChatProject[]).some((other) => other.projectId !== project.projectId && workspaceConnectionKey(other.connection) === workspaceConnectionKey(connection) && (connection?.kind === 'ssh' ? other.cwd === next.cwd : canonical(other.cwd) === next.cwd))) {
      throw new Error('Another project already uses this directory.')
    }
    if (workspaceConnectionKey(project.connection) !== workspaceConnectionKey(connection) || (connection?.kind === 'ssh' ? project.cwd !== next.cwd : canonical(project.cwd) !== next.cwd)) {
      const { workspaces, sessions, memberIds } = projectChats(state, project.projectId)
      for (const workspace of workspaces) plans.push(prepareChatProjectMove(host, workspace.sessionId, next.cwd, connection))
      for (const session of sessions) if (!memberIds.has(session.sessionId)) plans.push(prepareChatProjectMove(host, session.sessionId, next.cwd, connection))
    }
  }
  // All guards and directory metadata are resolved before changing any member.
  const ts = now()
  next.updatedAt = ts
  state.chatProjects[project.projectId] = next
  for (const plan of plans) applyChatProjectMove(plan, project.projectId, ts)
  return publish(host, 'chat.project.updated', { projectId: project.projectId, label: next.label, cwd: next.cwd, pinned: next.pinned, sectionId: next.sectionId }, ctx)
}

export function archiveChatProjectChats(host: ProjectHost, input: JsonRecord, ctx: JsonRecord) {
  human(ctx)
  const state = host.state()
  const project = projectFor(state, input.projectId)
  const { workspaces, sessions } = projectChats(state, project.projectId)
  if (sessions.some((session) => ['running', 'pending'].includes(session.status) || host.runs().has(session.sessionId) ||
      session.threadGoal?.status === 'active' || (state.runQueue ?? []).some((queued) => queued.sessionId === session.sessionId)) ||
      workspaces.some((workspace) => Object.values(workspace.triggers ?? {}).some((trigger: JsonRecord) => ['running', 'pending'].includes(trigger.status)))) {
    throw new Error('Wait for all project chats to finish before archiving them.')
  }
  const ts = now()
  for (const session of sessions) {
    session.archived = true
    host.appendKernelEvent('session.archived', { sessionId: session.sessionId, archived: true }, ctx)
  }
  for (const workspace of workspaces) {
    workspace.archived = true
    workspace.updatedAt = ts
    const discussion = workspace.activeDiscussionId ? workspace.discussions[workspace.activeDiscussionId] : undefined
    if (discussion?.status === 'active') { discussion.status = 'paused'; discussion.pauseReason = 'Workspace archived.' }
  }
  return publish(host, 'chat.project.chats.archived', { projectId: project.projectId, sessionIds: sessions.map((session) => session.sessionId), workspaceIds: workspaces.map((workspace) => workspace.sessionId) }, ctx)
}

export function removeChatProject(host: ProjectHost, input: JsonRecord, ctx: JsonRecord) {
  human(ctx)
  const state = host.state()
  const project = projectFor(state, input.projectId)
  for (const chat of [...Object.values(state.sessions), ...Object.values(state.collaborationSessions ?? {})] as JsonRecord[]) {
    if (chat.chatProjectId === project.projectId) delete chat.chatProjectId
  }
  delete state.chatProjects[project.projectId]
  return publish(host, 'chat.project.removed', { projectId: project.projectId }, ctx)
}

export function upsertChatProjectSection(host: ProjectHost, input: JsonRecord, ctx: JsonRecord) {
  human(ctx)
  const state = host.state()
  const sections = state.chatProjectSections ?? {}
  const sectionId = input.sectionId === undefined ? randomUUID() : optionalTrimmedString(input.sectionId)
  const existing = sectionId && Object.hasOwn(sections, sectionId) ? sections[sectionId] : undefined
  if (!sectionId || input.sectionId !== undefined && !existing) throw new Error('Choose an existing project section.')
  const nextLabel = label(input.label, 'Section')
  if ((Object.values(sections) as ChatProjectSection[]).some((section) => section.sectionId !== sectionId && section.label.toLocaleLowerCase() === nextLabel.toLocaleLowerCase())) {
    throw new Error('A section with this name already exists.')
  }
  const ts = now()
  state.chatProjectSections = { ...sections, [sectionId]: { sectionId, label: nextLabel, createdAt: existing?.createdAt ?? ts, updatedAt: ts } }
  publish(host, 'chat.project.section.upserted', { sectionId, label: nextLabel }, ctx)
  return { sectionId, state: host.getState() }
}

export function removeChatProjectSection(host: ProjectHost, input: JsonRecord, ctx: JsonRecord) {
  human(ctx)
  const state = host.state()
  const sectionId = optionalTrimmedString(input.sectionId)
  if (!sectionId || !Object.hasOwn(state.chatProjectSections ?? {}, sectionId)) throw new Error('Choose an existing project section.')
  delete state.chatProjectSections[sectionId]
  const ts = now()
  for (const project of Object.values(state.chatProjects ?? {}) as ChatProject[]) if (project.sectionId === sectionId) { delete project.sectionId; project.updatedAt = ts }
  return publish(host, 'chat.project.section.removed', { sectionId }, ctx)
}

export function normalizeChatProjectSections(value: unknown, diagnostics: JsonRecord[]): Record<string, ChatProjectSection> {
  const sections: Record<string, ChatProjectSection> = {}
  if (!isObject(value)) return sections
  for (const [sectionId, raw] of Object.entries(value)) {
    if (!isObject(raw) || raw.sectionId !== sectionId || !optionalTrimmedString(raw.label) ||
        !Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.updatedAt))) {
      diagnostics.push(diagnostic('storage.chat_project_section_skipped', 'Skipped an invalid saved project section.', { sectionId }))
      continue
    }
    sections[sectionId] = { sectionId, label: raw.label.trim(), createdAt: raw.createdAt, updatedAt: raw.updatedAt }
  }
  return sections
}

export function normalizeChatProjectSectionReferences(state: JsonRecord) {
  for (const project of Object.values(state.chatProjects ?? {}) as ChatProject[]) {
    if (project.sectionId && !Object.hasOwn(state.chatProjectSections ?? {}, project.sectionId)) delete project.sectionId
  }
}
