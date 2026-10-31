import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import type { AgentSession } from '@/shared/graph-state';
import type { CollaborationSession } from '@shared/collaboration';

/** Selection and keyboard activation have one owner, including nested row action handling. */
export function SidebarChatRow({
  chat,
  onSelect,
  renderContextMenu,
  children,
  ...props
}: {
  chat: AgentSession | CollaborationSession;
  onSelect: () => void;
  renderContextMenu: (chat: AgentSession | CollaborationSession, row: ReactElement<HTMLAttributes<HTMLElement>>) => ReactNode;
  children: ReactNode;
  className: string;
}) {
  return renderContextMenu(
    chat,
    <div
      {...props}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {children}
    </div>,
  );
}
