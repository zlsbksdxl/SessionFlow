export const relationshipPromptsStorageKey = 'orrery.relationshipPrompts.v1';

type PromptReader = Pick<Storage, 'getItem'>;
type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function relationshipPromptKey(data: { edgeId?: string; subscriptionId?: string }): string | undefined {
  const subscriptionId = data.subscriptionId?.trim();
  if (subscriptionId) return `subscription:${subscriptionId}`;
  const edgeId = data.edgeId?.trim();
  return edgeId ? `edge:${edgeId}` : undefined;
}

function validPromptKey(key: string) {
  return /^(?:edge|subscription):\S[\s\S]*$/.test(key);
}

function parsePrompts(raw: string | null): Record<string, string> {
  const prompts: Record<string, string> = Object.create(null);
  if (!raw) return prompts;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return prompts;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prompts;
  for (const [key, prompt] of Object.entries(value)) {
    if (validPromptKey(key) && typeof prompt === 'string' && prompt.trim()) prompts[key] = prompt;
  }
  return prompts;
}

export function readRelationshipPrompt(key: string, storage?: PromptReader): string {
  if (!validPromptKey(key)) return '';
  try {
    const reader = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    return reader ? (parsePrompts(reader.getItem(relationshipPromptsStorageKey))[key] ?? '') : '';
  } catch {
    return '';
  }
}

export function writeRelationshipPrompt(key: string, prompt: string, storage?: PromptStorage): void {
  if (!validPromptKey(key)) throw new Error('Choose a relationship before saving its prompt.');
  const writer = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  if (!writer) throw new Error('Relationship prompt storage is unavailable.');

  // Read failures must propagate, otherwise saving could overwrite unrelated
  // prompts that could not be read. A failed write must not appear successful.
  const prompts = parsePrompts(writer.getItem(relationshipPromptsStorageKey));
  const normalized = prompt.trim();
  if (normalized) prompts[key] = normalized;
  else delete prompts[key];
  writer.setItem(relationshipPromptsStorageKey, JSON.stringify(prompts));
}
