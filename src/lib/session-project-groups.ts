import type { ChatProject } from '@shared/chat-projects';

type ProjectChat = {
  cwd: string;
  updatedAt: string;
  chatProjectId?: string;
};

export type ProjectChatGroup<T> = {
  key: string;
  label: string;
  cwd: string;
  chats: T[];
  hasDuplicateName: boolean;
};

export function isChatInProject(chat: { chatProjectId?: string }, projects: Record<string, ChatProject>) {
  return typeof chat.chatProjectId === 'string' && Object.hasOwn(projects, chat.chatProjectId);
}

// Project membership is explicit. A shared execution cwd never assigns a chat
// to a project, and callers own archive/search filters and chat ordering.
export function groupChatsByProject<T extends ProjectChat>(chats: readonly T[], projects: Record<string, ChatProject>): ProjectChatGroup<T>[] {
  const groups = new Map(
    Object.values(projects).map((project): [string, ProjectChatGroup<T>] => [
      project.projectId,
      {
        key: project.projectId,
        label: project.label,
        cwd: project.cwd,
        chats: [],
        hasDuplicateName: false,
      },
    ]),
  );
  const latestUpdates = new Map(Object.values(projects).map((project) => [project.projectId, project.updatedAt]));

  for (const chat of chats) {
    if (!isChatInProject(chat, projects)) continue;
    const group = groups.get(chat.chatProjectId!);
    if (!group) continue;
    group.chats.push(chat);
    if (chat.updatedAt > latestUpdates.get(group.key)!) latestUpdates.set(group.key, chat.updatedAt);
  }

  const nameCounts = new Map<string, number>();
  for (const group of groups.values()) nameCounts.set(group.label, (nameCounts.get(group.label) ?? 0) + 1);
  for (const group of groups.values()) group.hasDuplicateName = (nameCounts.get(group.label) ?? 0) > 1;

  return [...groups.values()].sort((left, right) => latestUpdates.get(right.key)!.localeCompare(latestUpdates.get(left.key)!));
}
