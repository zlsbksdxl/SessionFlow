import { useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { chatNameMaxLength } from '@shared/chat-name';

export function ChatRenameDialog({ initialName, onSave, onClose }: { initialName: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = name.trim().length > 0 && name.trim().length <= chatNameMaxLength;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/15" />
        <Dialog.Content
          className="app-region-no-drag fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-foreground/10 bg-muted p-5 text-foreground shadow-[0_8px_24px_-12px_rgba(0,0,0,0.2)] focus:outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <button
            type="button"
            aria-label="Close rename chat"
            disabled={saving}
            onClick={onClose}
            className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-foreground/70 transition hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring/70 disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <Dialog.Title className="pr-8 text-xl font-semibold leading-7 tracking-[-0.02em]">Rename chat</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-foreground/45">Keep it short and recognizable</Dialog.Description>
          <form
            className="mt-3.5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || saving) return;
              setSaving(true);
              setError(undefined);
              void onSave(name.trim())
                .catch((cause) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                })
                .finally(() => setSaving(false));
            }}
          >
            <input
              ref={inputRef}
              aria-label="Chat name"
              required
              maxLength={chatNameMaxLength}
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
              className="h-9 w-full rounded-lg border border-foreground/10 bg-background/70 px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
            />
            {name.trim().length > chatNameMaxLength ? <p className="text-xs text-term-rose">Use {chatNameMaxLength} characters or fewer.</p> : null}
            {error ? (
              <p role="alert" className="text-xs leading-5 text-term-rose">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-8 min-w-[78px] rounded-[10px] border-foreground/10 bg-background/60 px-4 text-sm font-normal hover:bg-background"
                disabled={saving}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-8 min-w-[66px] rounded-[10px] bg-foreground px-4 text-sm font-normal text-background hover:bg-foreground/90"
                disabled={!valid || saving}
              >
                {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
