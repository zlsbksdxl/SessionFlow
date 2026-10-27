/** Explicit sidebar projects. Execution workspace metadata alone is not membership. */
export type ChatProjectConnection = { kind: 'local' } | { kind: 'ssh'; host: string; runtimePath: string }

export type ChatProject = {
  projectId: string
  label: string
  cwd: string
  pinned?: boolean
  sectionId?: string
  connection?: ChatProjectConnection
  createdAt: string
  updatedAt: string
}

export type ChatProjectSection = {
  sectionId: string
  label: string
  createdAt: string
  updatedAt: string
}
