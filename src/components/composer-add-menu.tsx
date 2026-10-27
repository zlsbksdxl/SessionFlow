import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, MessagesSquare, Paperclip, Plus, Search, X } from 'lucide-react';
import { Dialog, DropdownMenu } from 'radix-ui';
import { Button } from '@/components/ui/button';
import type { AgentSession } from '@/shared/graph-state';
import { chatContextAttachmentId, chatContextMessageCount } from '@/lib/chat-context-attachment';
import { compactPath } from '@/lib/format';
import { sessionDisplayLabel, sessionProviderLabel } from '@/lib/session-display';

export function ComposerAddMenu({
  disabled,
  sessions,
  currentSessionId,
  attachmentIds,
  onAddFiles,
  onAddChat,
}: {
  disabled?: boolean;
  sessions: AgentSession[];
  currentSessionId?: string;
  attachmentIds: string[];
  onAddFiles: () => void;
  onAddChat: (session: AgentSession) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const availableSessions = useMemo(() => {
    if (!pickerOpen || disabled) return [];
    const search = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      if (session.sessionId === currentSessionId || session.archived) return false;
      return !search || [sessionDisplayLabel(session), sessionProviderLabel(session), session.cwd].some((value) => value.toLocaleLowerCase().includes(search));
    });
  }, [sessions, currentSessionId, query, pickerOpen, disabled]);

  useEffect(() => {
    if (!pickerOpen) setQuery('');
  }, [pickerOpen]);

  useEffect(() => {
    if (disabled) setPickerOpen(false);
  }, [disabled]);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            ref={addButtonRef}
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label="Add files or chat"
            title="Add files or chat"
            className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-4" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              if (pickerOpen) event.preventDefault();
            }}
            className="app-region-no-drag z-50 min-w-56 rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            <DropdownMenu.Label className="px-2.5 py-1.5 text-xs text-muted-foreground">Add</DropdownMenu.Label>
            <DropdownMenu.Item
              disabled={disabled}
              className="flex h-9 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted"
              onSelect={onAddFiles}
            >
              <Paperclip className="size-4" />
              Add files
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={disabled}
              className="flex h-9 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted"
              onSelect={() => setPickerOpen(true)}
            >
              <MessagesSquare className="size-4" />
              Add chat
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Dialog.Root open={pickerOpen && !disabled} onOpenChange={setPickerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
          <Dialog.Content
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              addButtonRef.current?.focus();
            }}
            className="app-region-no-drag fixed left-1/2 top-[15dvh] z-50 flex max-h-[70dvh] w-[min(calc(100vw-2rem),560px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="text-base font-semibold">Add chat</Dialog.Title>
                <Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">
                  Attach another chat's recent messages as context for your next message.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Close chat picker">
                  <X className="size-4" />
                </Button>
              </Dialog.Close>
            </div>
            <div className="my-3 flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search chats to attach"
                placeholder="Search chats"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="min-h-0 overflow-y-auto" aria-label="Available chats">
              {availableSessions.slice(0, 50).map((session) => {
                const attached = attachmentIds.includes(chatContextAttachmentId(session.sessionId));
                const messageCount = chatContextMessageCount(session);
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    disabled={attached || messageCount === 0}
                    onClick={() => {
                      onAddChat(session);
                      setPickerOpen(false);
                    }}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left outline-none hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{sessionDisplayLabel(session)}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {sessionProviderLabel(session)} · {session.cwd ? compactPath(session.cwd) : 'No project'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground">
                      {attached ? (
                        <>
                          <Check className="size-3.5" /> Added
                        </>
                      ) : messageCount ? (
                        `${messageCount} messages`
                      ) : (
                        'No completed messages'
                      )}
                    </span>
                  </button>
                );
              })}
              {!availableSessions.length ? (
                <p role="status" className="py-8 text-center text-sm text-muted-foreground">
                  {query.trim() ? 'No chats match your search.' : 'No other chats to add yet.'}
                </p>
              ) : null}
              {availableSessions.length > 50 ? (
                <p className="px-2.5 py-2 text-xs text-muted-foreground">Showing the first 50 chats. Search to find another.</p>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
