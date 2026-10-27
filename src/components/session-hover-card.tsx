import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Clock3, FolderOpen } from 'lucide-react';
import { HoverCard } from 'radix-ui';
import type { AgentSession } from '@/shared/graph-state';
import { formatTimestamp } from '@/lib/format';
import { runtimeConfigSummary } from '@/lib/provider-catalog';
import { sessionDisplayLabel, sessionProviderLabel } from '@/lib/session-display';

function SessionDetails({ session }: { session: AgentSession }) {
  return (
    <>
      <p className="break-words text-sm font-medium leading-5">{sessionDisplayLabel(session)}</p>
      <p className="mt-1.5 break-words text-xs leading-5 text-muted-foreground">
        {sessionProviderLabel(session)} · {runtimeConfigSummary(session.providerKind, session.runtimeSettings, session.effectiveRuntimeConfig)}
      </p>
      <div className="mt-3 space-y-2.5 border-t border-border pt-3 text-xs leading-5">
        <div className="flex items-start gap-2.5">
          <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 break-all" aria-label="Project directory">
            {session.cwd.trim() || 'No project'}
          </span>
        </div>
        <div className="flex items-center gap-2.5 text-muted-foreground">
          <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
          <span>Updated {formatTimestamp(session.updatedAt)}</span>
        </div>
      </div>
    </>
  );
}

export function SessionHoverCard({ session, children, disabled = false }: { session: AgentSession; children: ReactElement; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const allowOpenRef = useRef(true);

  useEffect(() => {
    if (disabled) {
      allowOpenRef.current = false;
      setOpen(false);
    }
  }, [disabled]);

  return (
    <HoverCard.Root
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        if (!nextOpen || (!disabled && allowOpenRef.current)) setOpen(nextOpen);
      }}
      openDelay={500}
      closeDelay={150}
    >
      <HoverCard.Trigger
        asChild
        onPointerEnter={(event) => {
          if (disabled) event.preventDefault();
          else allowOpenRef.current = true;
        }}
        onFocus={(event) => {
          if (disabled) event.preventDefault();
          else allowOpenRef.current = true;
        }}
        onContextMenu={() => {
          // A queued hover delay must not reopen the card after the menu closes.
          allowOpenRef.current = false;
          setOpen(false);
        }}
      >
        {children}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          aria-label="Chat details"
          className="app-region-no-drag pointer-events-auto z-50 max-h-[calc(100dvh-1.5rem)] w-80 max-w-[calc(100vw-1.5rem)] select-text overflow-y-auto rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg outline-none"
        >
          <SessionDetails session={session} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
