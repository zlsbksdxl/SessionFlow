import { useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { FolderOpen, LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RuntimeApi } from '@/runtime-client';
import type { ChatProject } from '@shared/chat-projects';

const nameMaxLength = 200;
type ProjectConnection = { kind: 'local' } | { kind: 'ssh'; host: string; runtimePath: string };
const inputClass =
  'h-9 min-w-0 flex-1 rounded-lg border border-foreground/10 bg-background/70 px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60';

export function ChatProjectSettingsDialog({
  project,
  mode,
  runtimeApi,
  onSave,
  onClose,
}: {
  project: ChatProject & { connection?: ProjectConnection };
  mode: 'edit' | 'connection';
  runtimeApi: RuntimeApi | undefined;
  onSave: (input: { label?: string; cwd?: string; connection?: ProjectConnection }) => Promise<void>;
  onClose: () => void;
}) {
  const connection = mode === 'connection';
  const initialConnection = project.connection ?? { kind: 'local' };
  const [connectionKind, setConnectionKind] = useState<ProjectConnection['kind']>(initialConnection.kind);
  const [host, setHost] = useState(initialConnection.kind === 'ssh' ? initialConnection.host : '');
  const [runtimePath, setRuntimePath] = useState(initialConnection.kind === 'ssh' ? initialConnection.runtimePath : '');
  const [value, setValue] = useState(connection ? project.cwd : project.label);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState<string>();
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = saving || choosing || testing;
  const ssh = connectionKind === 'ssh';
  const valid =
    value.trim().length > 0 &&
    (connection || value.trim().length <= nameMaxLength) &&
    (!connection || !ssh || (host.trim().length > 0 && runtimePath.trim().startsWith('/') && value.trim().startsWith('/')));

  function clearConnectionResult() {
    setTestSuccess(undefined);
    setError(undefined);
  }

  function selectedConnection(): ProjectConnection {
    return ssh ? { kind: 'ssh', host: host.trim(), runtimePath: runtimePath.trim() } : { kind: 'local' };
  }

  async function chooseFolder() {
    if (!runtimeApi || busy) return;
    setChoosing(true);
    setError(undefined);
    try {
      const result = await runtimeApi.chooseProjectFolder();
      if (!result.canceled && result.cwd) {
        setValue(result.cwd);
        setTestSuccess(undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  }

  async function testConnection() {
    if (!runtimeApi || !valid || busy) return;
    setTesting(true);
    clearConnectionResult();
    try {
      const result = await runtimeApi.dispatchCommand({
        kind: 'test_chat_project_connection',
        input: { connection: selectedConnection(), cwd: value.trim() },
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
    if (!valid || busy) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(connection ? { cwd: value.trim(), connection: selectedConnection() } : { label: value.trim() });
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
          className="app-region-no-drag fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[20px] border border-foreground/10 bg-muted p-5 text-foreground shadow-[0_8px_24px_-12px_rgba(0,0,0,0.2)] focus:outline-none"
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
            aria-label={connection ? 'Close project connection settings' : 'Close edit project'}
            disabled={busy}
            onClick={onClose}
            className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-foreground/70 transition hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring/70 disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <Dialog.Title className="pr-8 text-xl font-semibold leading-7 tracking-[-0.02em]">{connection ? 'Edit connection' : 'Edit project'}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-foreground/45">
            {connection ? 'Future messages run here. Existing files stay in place.' : 'Give this project a short, recognizable name.'}
          </Dialog.Description>
          <form
            className="mt-3.5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {connection ? (
              <label className="grid gap-1.5 text-xs text-foreground/60">
                Connection
                <select
                  aria-label="Project connection"
                  value={connectionKind}
                  disabled={busy}
                  onChange={(event) => {
                    setConnectionKind(event.target.value as ProjectConnection['kind']);
                    clearConnectionResult();
                  }}
                  className={`${inputClass} w-full`}
                >
                  <option value="local">This computer</option>
                  <option value="ssh">SSH server</option>
                </select>
              </label>
            ) : null}
            {connection && ssh ? (
              <>
                <label className="grid gap-1.5 text-xs text-foreground/60">
                  SSH host
                  <input
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
              {connection ? (ssh ? 'Remote project folder' : 'Project folder') : 'Project name'}
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  aria-label={connection ? (ssh ? 'Remote project folder' : 'Project folder') : 'Project name'}
                  required
                  maxLength={connection ? undefined : nameMaxLength}
                  value={value}
                  disabled={busy}
                  spellCheck={!connection}
                  placeholder={connection ? '/path/to/project' : undefined}
                  onChange={(event) => {
                    setValue(event.target.value);
                    clearConnectionResult();
                  }}
                  className={inputClass}
                />
                {connection && !ssh ? (
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
            {connection && ssh ? (
              <p className="text-[11px] leading-4 text-foreground/45">
                The server needs Node.js, a matching SessionFlow build, and a signed-in provider. Use an SSH key or your SSH config.
              </p>
            ) : null}
            {!connection && value.trim().length > nameMaxLength ? <p className="text-xs text-term-rose">Use {nameMaxLength} characters or fewer.</p> : null}
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
            <div className="flex flex-wrap justify-end gap-3">
              {connection ? (
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
                {saving ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
