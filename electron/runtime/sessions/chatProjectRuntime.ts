import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatProject } from '../../../shared/chat-projects.js'
import { diagnostic, isObject, now, optionalTrimmedString, type JsonRecord } from '../runtimeCommon.js'
import { localSessionWorkspace, projectNameFromCwd, validateRunnableCwd } from '../workspace/gitWorkspace.js'
import type { SessionCommandRuntimeHost } from './sessionCommandRuntime.js'
import type { ChatProjectConnection } from '../../../shared/chat-projects.js'
import { normalizeWorkspaceConnection, workspaceConnectionKey, validateRemoteWorkspaceCwd, testChatProjectConnection } from '../workspace/remoteWorkspace.js'
import { bindSessionWorkspaceConnection } from './workspaceConnectionState.js'

export type ProjectHost = Pick<SessionCommandRuntimeHost, 'state' | 'runs' | 'getState' | 'appendKernelEvent' | 'touch' | 'broadcast'>

function requireHuman(ctx: JsonRecord) {
  if (ctx.actor?.kind !== 'human') throw new Error('Only a human can manage chat projects.')
}

function canonicalDirectory(value: unknown) {
  const cwd = optionalTrimmedString(value)
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('Choose an absolute project directory.')
  return fs.realpathSync(validateRunnableCwd(cwd))
}

function sameDirectory(left: string, right: string) {
  try { return fs.realpathSync(left) === fs.realpathSync(right) }
  catch { return path.resolve(left) === path.resolve(right) }
}

/** Explicit create-time membership is checked before worktree/channel/provider side effects. */
export function workspaceMetadata(cwd: string, connection?: ChatProjectConnection) {
  return connection?.kind === 'ssh'
    ? { cwd: validateRemoteWorkspaceCwd(cwd), project: { name: path.posix.basename(cwd) || cwd, cwd, workMode: 'local' } }
    : localSessionWorkspace(cwd, undefined)
}

export async function resolvedProjectDirectory(cwd: unknown, connection?: ChatProjectConnection, providerKind?: string) {
  if (connection?.kind !== 'ssh') return canonicalDirectory(cwd)
  const result = await testChatProjectConnection({ connection, cwd: validateRemoteWorkspaceCwd(cwd), ...(providerKind ? { providerKind } : {}) })
  return validateRemoteWorkspaceCwd(result.cwd)
}

export function chatProjectForNewSession(state: JsonRecord, input: JsonRecord) {
  if (input.chatProjectId === undefined) {
    const workspaceConnection = normalizeWorkspaceConnection(input.workspaceConnection)
    if (workspaceConnection?.kind === 'ssh') {
      return resolvedProjectDirectory(input.cwd, workspaceConnection, input.providerKind).then((cwd) => ({ cwd, chatProjectId: undefined, workspaceConnection }))
    }
    return { cwd: input.cwd, chatProjectId: undefined, workspaceConnection }
  }
  const chatProjectId = optionalTrimmedString(input.chatProjectId)
  const project = chatProjectId && Object.hasOwn(state.chatProjects ?? {}, chatProjectId) ? state.chatProjects[chatProjectId] as ChatProject : undefined
  if (!project) throw new Error('Choose an existing project for this new chat.')
  const workspaceConnection = normalizeWorkspaceConnection(project.connection)
  if (Object.hasOwn(input, 'workspaceConnection') && workspaceConnectionKey(input.workspaceConnection) !== workspaceConnectionKey(workspaceConnection)) throw new Error('The new chat connection must match the selected project.')
  const projectCwd = workspaceConnection?.kind === 'ssh' ? validateRemoteWorkspaceCwd(project.cwd) : canonicalDirectory(project.cwd)
  const finish = (cwd: string) => {
    const sourceId = optionalTrimmedString(input.sourceSessionId)
    const source = sourceId ? state.sessions[sourceId] : undefined
    const inheritsSourceWorkspace = source?.chatProjectId === chatProjectId && workspaceConnectionKey(source.workspaceConnection) === workspaceConnectionKey(workspaceConnection) && (workspaceConnection?.kind === 'ssh' ? source.cwd === cwd : sameDirectory(source.cwd, cwd))
    // A linked chat may share its source's existing worktree without taking
    // ownership of that worktree or changing its explicitly selected project.
    if ((workspaceConnection?.kind === 'ssh' ? cwd !== projectCwd : !sameDirectory(cwd, projectCwd)) && !inheritsSourceWorkspace) {
      if (workspaceConnection?.kind === 'ssh') throw new Error('The remote chat directory must match the selected project.')
      const selected = localSessionWorkspace(cwd, undefined)
      if (!sameDirectory(selected.project.cwd, projectCwd)) throw new Error('The new chat directory must match the selected project.')
    }
    return { cwd, chatProjectId, workspaceConnection }
  }
  return workspaceConnection?.kind === 'ssh'
    ? resolvedProjectDirectory(input.cwd ?? projectCwd, workspaceConnection, input.providerKind).then(finish)
    : finish(canonicalDirectory(input.cwd ?? projectCwd))
}

export function upsertChatProject(host: ProjectHost, input: JsonRecord, ctx: JsonRecord) {
  requireHuman(ctx)
  const connection = normalizeWorkspaceConnection(input.connection)
  if (connection?.kind === 'ssh') return resolvedProjectDirectory(input.cwd, connection).then((cwd) => upsertResolvedChatProject(host, input, ctx, cwd, connection))
  const cwd = canonicalDirectory(input.cwd)
  return upsertResolvedChatProject(host, input, ctx, cwd, connection)
}

function upsertResolvedChatProject(host: ProjectHost, input: JsonRecord, ctx: JsonRecord, cwd: string, connection?: ChatProjectConnection) {
  if (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim())) {
    throw new Error('Project name must be a non-empty string.')
  }
  const projects = host.state().chatProjects ?? {}
  const existing = Object.values(projects).find((project: JsonRecord) => workspaceConnectionKey(project.connection) === workspaceConnectionKey(connection) && (connection?.kind === 'ssh' ? project.cwd === cwd : sameDirectory(project.cwd, cwd))) as ChatProject | undefined
  const ts = now()
  const project: ChatProject = {
    ...existing,
    projectId: existing?.projectId ?? randomUUID(),
    label: optionalTrimmedString(input.label) ?? existing?.label ?? projectNameFromCwd(cwd),
    cwd,
    ...(connection ? { connection } : {}),
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  }
  host.state().chatProjects = { ...projects, [project.projectId]: project }
  host.appendKernelEvent('chat.project.upserted', { projectId: project.projectId, cwd, label: project.label }, ctx)
  host.touch()
  host.broadcast({ type: 'runtime.state', state: host.getState() })
  return { projectId: project.projectId, state: host.getState() }
}

function assertMovable(host: ProjectHost, session: JsonRecord, targetCwd: string | undefined, workspaceId?: string, connection?: ChatProjectConnection) {
  const state = host.state()
  const id = session.sessionId
  if (!['idle', 'failed'].includes(session.status) || host.runs().has(id) ||
      (state.runQueue ?? []).some((item) => item.sessionId === id)) {
    throw new Error('Wait for this chat to finish before moving it to a project.')
  }
  if (session.threadGoal?.status === 'active') throw new Error('Pause the active goal before moving this chat.')
  if (Object.values(state.collaborationSessions ?? {}).some((workspace: JsonRecord) =>
      workspace.sessionId !== workspaceId && workspace.members?.some((member) => member.sessionId === id))) {
    throw new Error('Move the whole group chat to change this member\'s project directory.')
  }
  if (!targetCwd || workspaceConnectionKey(session.workspaceConnection) === workspaceConnectionKey(connection) &&
      (connection?.kind === 'ssh' ? session.cwd === targetCwd : sameDirectory(session.cwd, targetCwd))) return
  if (session.project?.workMode === 'worktree') {
    throw new Error('A managed worktree chat cannot switch project directories.')
  }
  const clusters = Object.values(state.clusters ?? {}) as JsonRecord[]
  if (clusters.some((cluster) => cluster.nodeIds?.includes(id) || cluster.masterSessionId === id)) {
    throw new Error('Remove this chat from its managed cluster before switching project directories.')
  }
  const relations = Object.values(state.subscriptions ?? {}) as JsonRecord[]
  if (relations.some((relation) => relation.state === 'active' &&
      (relation.source?.sessionId === id || relation.target?.sessionId === id)) ||
      Object.values(state.pendingActivations ?? {}).some((activation: JsonRecord) => activation.target === id)) {
    throw new Error('Stop this chat\'s active workflow relationships before switching project directories.')
  }
  if (Object.values(state.planCouncils ?? {}).some((council: JsonRecord) =>
      !['completed', 'stopped', 'failed'].includes(council.phase) &&
      (council.participants?.[id] || council.synthesizerSessionId === id || council.coordinatorSessionId === id))) {
    throw new Error('Stop the active planning workflow before switching project directories.')
  }
  const plans = Object.values(state.workflowPlans ?? {}).flatMap((versions: JsonRecord) => Object.values(versions)) as JsonRecord[]
  if (plans.some((plan) => ['committing', 'active', 'replanning'].includes(plan.status) &&
      (plan.masterSessionId === id || Object.values(plan.executionMapping?.participantSessionIds ?? {}).includes(id))) ||
      Object.values(state.dynamicSpawnGroups ?? {}).some((group: JsonRecord) => ['creating', 'active'].includes(group.status) &&
      (group.parentSessionId === id || group.masterSessionId === id || group.children?.some((child) => child.sessionId === id)))) {
    throw new Error('Stop the active workflow before switching this chat\'s project directory.')
  }
}

/** A move changes future execution only; existing files and native conversation IDs remain intact. */
export function prepareChatProjectMove(host: ProjectHost, sessionId: string, targetCwd: string | undefined, connection?: ChatProjectConnection) {
  const state = host.state()
  const workspace = state.collaborationSessions?.[sessionId]
  const ordinary = state.sessions[sessionId]
  if (workspace && connection?.kind === 'ssh') throw new Error('SSH project connections currently support ordinary chats. Move this group chat to a local project.')
  if (!workspace && !ordinary) throw new Error(`Unknown chat: ${sessionId}`)
  const sessions: JsonRecord[] = workspace
    ? workspace.members.map((member) => {
        const session = state.sessions[member.sessionId]
        if (!session) throw new Error('This group chat has a missing member. Restore it before moving the group.')
        return session
      })
    : [ordinary]
  if (workspace && (Object.values(workspace.triggers ?? {}).some((trigger: JsonRecord) => ['pending', 'running'].includes(trigger.status)) ||
      targetCwd && !sameDirectory(workspace.cwd, targetCwd) && Object.values(workspace.discussions ?? {}).some((discussion: JsonRecord) => ['active', 'paused'].includes(discussion.status)))) {
    throw new Error('Finish or cancel the group chat discussion before switching project directories.')
  }
  // Validate every participant and build all new workspace metadata before any mutation.
  const updates = sessions.map((session) => {
    assertMovable(host, session, targetCwd, workspace?.sessionId, connection)
    const changed = targetCwd && (workspaceConnectionKey(session.workspaceConnection) !== workspaceConnectionKey(connection) || (connection?.kind === 'ssh' ? session.cwd !== targetCwd : !sameDirectory(session.cwd, targetCwd)))
    return { session, workspace: changed ? workspaceMetadata(targetCwd, connection) : undefined }
  })
  const previousCwds = sessions.map((session) => ({ sessionId: session.sessionId, cwd: session.cwd }))
  return { sessionId, workspace, ordinary, updates, previousCwds, targetCwd, connection }
}

export function applyChatProjectMove(plan: ReturnType<typeof prepareChatProjectMove>, projectId: string | undefined, ts = now()) {
  const { updates, workspace, targetCwd, connection } = plan
  for (const { session, workspace: nextWorkspace } of updates) {
    if (projectId) session.chatProjectId = projectId
    else delete session.chatProjectId
    if (nextWorkspace) {
      bindSessionWorkspaceConnection(session, connection)
      session.cwd = nextWorkspace.cwd
      session.project = nextWorkspace.project
      if (session.error?.includes('Project folder is no longer available')) session.error = undefined
    }
    session.updatedAt = ts
  }
  if (workspace) {
    if (projectId) workspace.chatProjectId = projectId
    else delete workspace.chatProjectId
    if (targetCwd) workspace.cwd = targetCwd
    workspace.updatedAt = ts
  }
}

export function moveChatToProject(host: ProjectHost, input: JsonRecord, ctx: JsonRecord) {
  requireHuman(ctx)
  const state = host.state()
  const sessionId = optionalTrimmedString(input.sessionId)
  if (!sessionId) throw new Error('Choose a chat to move.')
  const unassign = input.projectId === null
  const projectId = optionalTrimmedString(input.projectId)
  const project = !unassign && projectId ? state.chatProjects?.[projectId] as ChatProject | undefined : undefined
  if (!unassign && !project) throw new Error('Choose an existing project.')
  const connection = normalizeWorkspaceConnection(project?.connection)
  if (project && connection?.kind === 'ssh') return resolvedProjectDirectory(project.cwd, connection).then((cwd) => finishMoveChatToProject(host, sessionId, projectId, cwd, connection, ctx))
  const targetCwd = project ? canonicalDirectory(project.cwd) : undefined
  return finishMoveChatToProject(host, sessionId, projectId, targetCwd, connection, ctx)
}

function finishMoveChatToProject(host: ProjectHost, sessionId: string, projectId: string | undefined, targetCwd: string | undefined, connection: ChatProjectConnection | undefined, ctx: JsonRecord) {
  const plan = prepareChatProjectMove(host, sessionId, targetCwd, connection)
  applyChatProjectMove(plan, projectId)
  const { workspace, ordinary, previousCwds } = plan
  host.appendKernelEvent('chat.project.moved', { sessionId, projectId: projectId ?? null, cwd: targetCwd ?? workspace?.cwd ?? ordinary?.cwd, previousCwds }, ctx)
  host.touch()
  host.broadcast({ type: 'runtime.state', state: host.getState() })
  return { ok: true, state: host.getState() }
}

export function normalizeChatProjects(value: unknown, diagnostics: JsonRecord[]): Record<string, ChatProject> {
  const projects: Record<string, ChatProject> = {}
  if (!isObject(value)) return projects
  for (const [id, raw] of Object.entries(value)) {
    const valid = isObject(raw) && raw.projectId === id && optionalTrimmedString(id) &&
      optionalTrimmedString(raw.label) && typeof raw.cwd === 'string' && path.isAbsolute(raw.cwd) &&
      typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) &&
      typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))
    if (!valid) {
      diagnostics.push(diagnostic('storage.chat_project_skipped', 'Skipped an invalid saved chat project.', { projectId: id }))
      continue
    }
    let connection: ChatProjectConnection | undefined
    try { connection = normalizeWorkspaceConnection(raw.connection) } catch {
      diagnostics.push(diagnostic('storage.chat_project_connection_skipped', 'Skipped a project with an invalid connection.', { projectId: id })); continue
    }
    projects[id] = {
      projectId: id, label: raw.label.trim(), cwd: path.normalize(raw.cwd), createdAt: raw.createdAt, updatedAt: raw.updatedAt,
      ...(typeof raw.pinned === 'boolean' ? { pinned: raw.pinned } : {}),
      ...(optionalTrimmedString(raw.sectionId) ? { sectionId: raw.sectionId.trim() } : {}),
      ...(connection ? { connection } : {}),
    }
  }
  return projects
}

export function normalizeChatProjectMemberships(state: JsonRecord, diagnostics: JsonRecord[]) {
  const invalidReferences = new Set<string>()
  for (const chat of [...Object.values(state.sessions ?? {}), ...Object.values(state.collaborationSessions ?? {})] as JsonRecord[]) {
    if (chat.chatProjectId === undefined) continue
    if (typeof chat.chatProjectId !== 'string' || !Object.hasOwn(state.chatProjects ?? {}, chat.chatProjectId)) {
      diagnostics.push(diagnostic('storage.chat_project_reference_skipped', 'Returned a chat with an invalid project reference to Recents.', { sessionId: chat.sessionId }))
      invalidReferences.add(chat.sessionId)
      delete chat.chatProjectId
    }
  }
  return invalidReferences
}

function legacyProjectPath(chat: JsonRecord | undefined) {
  const value = optionalTrimmedString(chat?.project?.repoRoot) ?? optionalTrimmedString(chat?.project?.cwd) ?? optionalTrimmedString(chat?.cwd)
  if (!value) return undefined
  // Missing folders are still meaningful history. Never require them to exist
  // or run providers merely to recover sidebar membership.
  try { return fs.realpathSync(value) }
  catch { return path.resolve(value) }
}

/** Only pre-membership snapshots infer projects from workspace metadata. */
export function migrateLegacyChatProjectMemberships(state: JsonRecord, source: JsonRecord, diagnostics: JsonRecord[], invalidReferences: Set<string>) {
  const projects: Record<string, ChatProject> = state.chatProjects ?? {}
  const byCwd = new Map(Object.values(projects).filter((project) => project.connection?.kind !== 'ssh').map((project) => [legacyProjectPath(project), project]))
  const migratedAt = now()
  let created = 0
  let assigned = 0
  const ensureProject = (cwd: string, label?: string) => {
    let project = byCwd.get(cwd)
    if (!project) {
      const projectId = randomUUID()
      project = { projectId, label: optionalTrimmedString(label) ?? projectNameFromCwd(cwd), cwd, createdAt: migratedAt, updatedAt: migratedAt }
      projects[projectId] = project
      byCwd.set(cwd, project)
      created++
    }
    return project
  }
  const assign = (chat: JsonRecord | undefined, project: ChatProject) => {
    if (!chat || chat.chatProjectId !== undefined || invalidReferences.has(chat.sessionId)) return
    chat.chatProjectId = project.projectId
    assigned++
  }
  // A group's source workspace may itself be a worktree. When all members
  // identify the same original project, use that project for the whole group.
  for (const workspace of Object.values(state.collaborationSessions ?? {}) as JsonRecord[]) {
    if (invalidReferences.has(workspace.sessionId)) continue
    let project = workspace.chatProjectId ? projects[workspace.chatProjectId] : undefined
    if (!project) {
      const members = workspace.members.map((member) => source.sessions?.[member.sessionId]).filter(Boolean)
      const memberPaths = [...new Set(members.map(legacyProjectPath).filter(Boolean))] as string[]
      const cwd = memberPaths.length === 1 ? memberPaths[0] : legacyProjectPath(source.collaborationSessions?.[workspace.sessionId])
      if (!cwd) continue
      const label = members.find((member) => legacyProjectPath(member) === cwd)?.project?.name
      project = ensureProject(cwd, label)
      assign(workspace, project)
    }
    for (const member of workspace.members) assign(state.sessions[member.sessionId], project)
  }
  for (const session of Object.values(state.sessions ?? {}) as JsonRecord[]) {
    if (session.chatProjectId !== undefined || invalidReferences.has(session.sessionId)) continue
    const raw = source.sessions?.[session.sessionId]
    const cwd = legacyProjectPath(raw)
    if (cwd) assign(session, ensureProject(cwd, raw?.project?.name))
  }
  state.chatProjects = projects
  state.chatProjectMembershipVersion = 1
  if (created || assigned) diagnostics.push(diagnostic('storage.chat_projects_migrated', 'Recovered legacy chat project memberships from their existing workspaces.', { projectsCreated: created, assignedChats: assigned }))
}
