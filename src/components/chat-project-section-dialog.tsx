import { useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const nameMaxLength = 200;

export function ChatProjectSectionDialog({
  section,
  onSave,
  onRemove,
  onClose,
}: {
  section?: { sectionId: string; label: string };
  onSave: (label: string) => Promise<void>;
  onRemove?: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(section?.label ?? '');
  const [pending, setPending] = useState<'save' | 'remove'>();
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = Boolean(pending);
  const valid = name.trim().length > 0 && name.trim().length <= nameMaxLength;

  async function save() {
    if (!valid || busy) return;
    setPending('save');
    setError(undefined);
    try {
      await onSave(name.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  }

  async function remove() {
    if (!onRemove || busy) return;
    setPending('remove');
    setError(undefined);
    try {
      await onRemove();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/15" />
        <Dialog.Content
          aria-busy={busy}
          className="app-region-no-drag fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-foreground/10 bg-muted p-5 text-foreground shadow-[0_8px_24px_-12px_rgba(0,0,0,0.2)] focus:outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <button
            type="button"
            aria-label="Close project section dialog"
            disabled={busy}
            onClick={onClose}
            className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-foreground/70 transition hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring/70 disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <Dialog.Title className="pr-8 text-xl font-semibold leading-7 tracking-[-0.02em]">{section ? 'Edit section' : 'New section'}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-foreground/45">
            {onRemove ? 'Removing this section returns its projects to Projects and keeps their chats.' : 'Organize your projects into a named section.'}
          </Dialog.Description>
          <form
            className="mt-3.5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="grid gap-1.5 text-xs text-foreground/60">
              Section name
              <input
                ref={inputRef}
                aria-label="Section name"
                required
                maxLength={nameMaxLength}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                className="h-9 w-full rounded-lg border border-foreground/10 bg-background/70 px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
              />
            </label>
            {name.trim().length > nameMaxLength ? <p className="text-xs text-term-rose">Use {nameMaxLength} characters or fewer.</p> : null}
            {error ? (
              <p role="alert" className="text-xs leading-5 text-term-rose">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {onRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mr-auto h-8 rounded-[10px] px-2 text-xs font-normal text-term-rose hover:bg-term-rose/10 hover:text-term-rose"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {pending === 'remove' ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                  Remove section
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="h-8 min-w-[78px] rounded-[10px] border-foreground/10 bg-background/60 px-4 text-sm font-normal hover:bg-background"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-8 min-w-[66px] rounded-[10px] bg-foreground px-4 text-sm font-normal text-background hover:bg-foreground/90"
                disabled={!valid || busy}
              >
                {pending === 'save' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
