import { useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { FolderOpen, LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RuntimeApi } from '@/runtime-client';
import type { ChatProjectConnection } from '@shared/chat-projects';

const inputClass =
  'h-9 min-w-0 flex-1 rounded-lg border border-foreground/10 bg-background/70 px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60';

export function ChatProjectDialog({
  runtimeApi,
  movingChat,
  connectionKind = 'local',
  onSave,
  onClose,
}: {
  runtimeApi: RuntimeApi | undefined;
  movingChat: boolean;
  connectionKind?: 'local' | 'ssh';
  onSave: (cwd: string, label: string, connection?: ChatProjectConnection) => Promise<void>;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState('');
  const [host, setHost] = useState('');
  const [runtimePath, setRuntimePath] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState<string>();
  const [error, setError] = useState<string>();
  const primaryInputRef = useRef<HTMLInputElement>(null);
  const remote = connectionKind === 'ssh';
  const busy = saving || choosing || testing;
  const valid = Boolean(cwd.trim()) && (!remote || (Boolean(host.trim()) && runtimePath.trim().startsWith('/') && cwd.trim().startsWith('/')));

  function clearConnectionResult() {
    setTestSuccess(undefined);
    setError(undefined);
  }

  function selectedConnection(): ChatProjectConnection | undefined {
    return remote ? { kind: 'ssh', host: host.trim(), runtimePath: runtimePath.trim() } : undefined;
  }

  const chooseFolder = async () => {
    if (!runtimeApi || busy || remote) return;
    setChoosing(true);
    setError(undefined);
    try {
      const result = await runtimeApi.chooseProjectFolder();
      if (!result.canceled && result.cwd) setCwd(result.cwd);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  };

  async function testConnection() {
    if (!runtimeApi || !remote || !valid || busy) return;
    setTesting(true);
    clearConnectionResult();
    try {
      const result = await runtimeApi.dispatchCommand({
        kind: 'test_chat_project_connection',
        input: { connection: selectedConnection(), cwd: cwd.trim() },
      });
      if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : 'Connection could not be verified.');
      setTestSuccess(typeof result.cwd === 'string' ? `Connection verified: ${result.cwd}` : 'Connection verified.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!valid || busy || !runtimeApi) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(cwd.trim(), label.trim(), selectedConnection());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
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
          className="app-region-no-drag fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[20px] border border-foreground/10 bg-muted p-5 text-foreground shadow-[0_8px_24px_-12px_rgba(0,0,0,0.2)] focus:outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            primaryInputRef.current?.focus();
            primaryInputRef.current?.select();
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
            aria-label="Close project dialog"
            disabled={busy}
            onClick={onClose}
            className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-foreground/70 transition hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring/70 disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <Dialog.Title className="pr-8 text-xl font-semibold leading-7 tracking-[-0.02em]">
            {remote ? (movingChat ? 'Move to a new remote project' : 'New remote project') : movingChat ? 'Move to a new project' : 'Add project'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-foreground/45">
            {remote
              ? movingChat
                ? 'Future messages run on this SSH server. Chat history and existing files stay in place.'
                : 'Choose an SSH host and a project folder. You can move chats here from Recents.'
              : movingChat
                ? 'Future messages will work in this folder. Chat history and existing files stay in place.'
                : 'Choose a folder for this project. You can move chats here from Recents.'}
          </Dialog.Description>
          <form
            className="mt-3.5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {remote ? (
              <>
                <label className="grid gap-1.5 text-xs text-foreground/60">
                  SSH host
                  <input
                    ref={primaryInputRef}
                    aria-label="SSH host"
                    required
                    value={host}
                    disabled={busy}
                    spellCheck={false}
                    placeholder="my-server or user@hostname"
                    onChange={(event) => {
                      setHost(event.target.value);
                      clearConnectionResult();
                    }}
                    className={`${inputClass} w-full`}
                  />
                </label>
                <label className="grid gap-1.5 text-xs text-foreground/60">
                  SessionFlow folder
                  <input
                    aria-label="SessionFlow folder on server"
                    required
                    value={runtimePath}
                    disabled={busy}
                    spellCheck={false}
                    placeholder="/home/user/SessionFlow"
                    onChange={(event) => {
                      setRuntimePath(event.target.value);
                      clearConnectionResult();
                    }}
                    className={`${inputClass} w-full`}
                  />
                  <span className="text-[11px] leading-4 text-foreground/45">Folder containing SessionFlow on the server.</span>
                </label>
              </>
            ) : null}
            <label className="grid gap-1.5 text-xs text-foreground/60">
              {remote ? 'Remote project folder' : 'Project folder'}
              <div className="flex gap-2">
                <input
                  ref={remote ? undefined : primaryInputRef}
                  required
                  aria-label={remote ? 'Remote project folder' : 'Project folder'}
                  placeholder="/path/to/project"
                  value={cwd}
                  disabled={busy}
                  spellCheck={false}
                  onChange={(event) => {
                    setCwd(event.target.value);
                    clearConnectionResult();
                  }}
                  className={inputClass}
                />
                {!remote ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !runtimeApi}
                    onClick={() => void chooseFolder()}
                    className="h-9 shrink-0 rounded-lg border-foreground/10 bg-background/60 px-3 text-sm font-normal hover:bg-background"
                  >
                    {choosing ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <FolderOpen className="size-4" aria-hidden="true" />}
                    Browse
                  </Button>
                ) : null}
              </div>
            </label>
            <label className="grid gap-1.5 text-xs text-foreground/60">
              Name (optional)
              <input
                aria-label="Project name"
                placeholder="Folder name"
                maxLength={200}
                value={label}
                disabled={busy}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setError(undefined);
                }}
                className={`${inputClass} w-full`}
              />
            </label>
            {remote ? (
              <p className="text-[11px] leading-4 text-foreground/45">
                The server needs Node.js, a matching SessionFlow build, and a signed-in provider. Use an SSH key or your SSH config.
              </p>
            ) : null}
            {testSuccess ? (
              <p role="status" className="break-all text-xs leading-5 text-term-green">
                {testSuccess}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs leading-5 text-term-rose">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-3 pt-1">
              {remote ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mr-auto h-8 rounded-[10px] px-2 text-xs font-normal"
                  disabled={busy || !valid || !runtimeApi}
                  onClick={() => void testConnection()}
                >
                  {testing ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                  Test connection
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="h-8 rounded-[10px] border-foreground/10 bg-background/60 px-4 text-sm font-normal hover:bg-background"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-8 rounded-[10px] bg-foreground px-4 text-sm font-normal text-background hover:bg-foreground/90"
                disabled={busy || !valid || !runtimeApi}
              >
                {saving ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
                {movingChat ? 'Add project and move' : 'Add project'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
