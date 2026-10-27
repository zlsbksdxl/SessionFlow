export const chatNameMaxLength = 200

export type RenameChatInput = { sessionId: string; label: string }

export function normalizeChatName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Chat name must be a non-empty string.')
  const name = value.trim()
  if (name.length > chatNameMaxLength) throw new Error(`Chat name must be ${chatNameMaxLength} characters or fewer.`)
  return name
}
