import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { ArrowRight, FolderOpen, History, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentMarkdown } from '@/components/agent-markdown';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/format';
import { providerOption } from '@/lib/provider-catalog';
import type { GraphState } from '@/shared/graph-state';
import type { ProviderInstance } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import type { ImportNativeSessionResult, NativeSessionDetails, NativeSessionSummary } from '@shared/native-session';

const inputClass =
  'min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50';

export function NativeSessionImportDialog({
  runtimeApi,
  providerInstances,
  initialProviderInstanceId,
  onClose,
  onImported,
}: {
  runtimeApi: RuntimeApi;
  providerInstances: ProviderInstance[];
  initialProviderInstanceId?: string;
  onClose: () => void;
  onImported: (result: ImportNativeSessionResult<GraphState>) => void;
}) {
  const profiles = useMemo(() => providerInstances.filter((profile) => profile.kind === 'codex' || profile.kind === 'claude-code'), [providerInstances]);
  const [profileId, setProfileId] = useState(
    () => profiles.find((profile) => profile.providerInstanceId === initialProviderInstanceId)?.providerInstanceId ?? profiles[0]?.providerInstanceId ?? '',
  );
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [sessions, setSessions] = useState<NativeSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [listWarnings, setListWarnings] = useState<string[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const [selected, setSelected] = useState<NativeSessionSummary>();
  const [details, setDetails] = useState<NativeSessionDetails>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [cwd, setCwd] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string>();
  const listGeneration = useRef(0);
  const profile = profiles.find((item) => item.providerInstanceId === profileId);

  useEffect(() => {
    const generation = ++listGeneration.current;
    let live = true;
    setListLoading(true);
    setMoreLoading(false);
    setListError(undefined);
    setListWarnings([]);
    setSessions([]);
    setNextCursor(undefined);
    setSelected(undefined);
    setDetails(undefined);
    setImportError(undefined);
    if (!profileId) {
      setListLoading(false);
      return;
    }
    if (
      typeof runtimeApi.listNativeSessions !== 'function' ||
      typeof runtimeApi.readNativeSession !== 'function' ||
      typeof runtimeApi.importNativeSession !== 'function'
    ) {
      setListError('Restart SessionFlow to enable chat import, then open Import chat again.');
      setListLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void runtimeApi
        .listNativeSessions({ providerInstanceId: profileId, search: search.trim() || undefined, archived, limit: 50 })
        .then((result) => {
          if (!live || generation !== listGeneration.current) return;
          setSessions(result.sessions);
          setNextCursor(result.nextCursor);
          setListWarnings(result.warnings ?? []);
        })
        .catch((error: unknown) => {
          if (live && generation === listGeneration.current) setListError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (live && generation === listGeneration.current) setListLoading(false);
        });
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [runtimeApi, profileId, search, archived, refresh]);

  useEffect(() => {
    let live = true;
    setDetails(undefined);
    setPreviewError(undefined);
    setImportError(undefined);
    setCwd('');
    if (!selected) {
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    void runtimeApi
      .readNativeSession({ providerInstanceId: selected.providerInstanceId, nativeSessionId: selected.nativeSessionId })
      .then((result) => {
        if (!live) return;
        setDetails(result);
        setCwd(result.session.cwd);
      })
      .catch((error: unknown) => {
        if (live) setPreviewError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (live) setPreviewLoading(false);
      });
    return () => {
      live = false;
    };
  }, [runtimeApi, selected]);

  const loadMore = async () => {
    if (!nextCursor || moreLoading || listLoading) return;
    const generation = listGeneration.current;
    setMoreLoading(true);
    setListError(undefined);
    try {
      const result = await runtimeApi.listNativeSessions({
        providerInstanceId: profileId,
        search: search.trim() || undefined,
        archived,
        limit: 50,
        cursor: nextCursor,
      });
      if (generation !== listGeneration.current) return;
      setSessions((current) => [...new Map([...current, ...result.sessions].map((item) => [`${item.sourceKey}:${item.nativeSessionId}`, item])).values()]);
      setNextCursor(result.nextCursor);
      setListWarnings((current) => [...new Set([...current, ...(result.warnings ?? [])])]);
    } catch (error: unknown) {
      if (generation === listGeneration.current) setListError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === listGeneration.current) setMoreLoading(false);
    }
  };

  const importChat = async () => {
    if (!details || importing || listLoading || (details.session.active && !details.session.importedSessionId)) return;
    setImporting(true);
    setImportError(undefined);
    try {
      const result = await runtimeApi.importNativeSession({
        providerInstanceId: details.session.providerInstanceId,
        nativeSessionId: details.session.nativeSessionId,
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      });
      onImported(result);
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : String(error));
      setImporting(false);
    }
  };

  const chooseFolder = async () => {
    try {
      const result = await runtimeApi.chooseProjectFolder();
      if (!result.canceled && result.cwd) setCwd(result.cwd);
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  const previewMessages = details?.messages.slice(-60) ?? [];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !importing) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="app-region-no-drag fixed left-1/2 top-1/2 z-50 flex h-[min(82dvh,760px)] w-[min(calc(100vw-2rem),1080px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl focus:outline-none"
        >
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <History className="mt-0.5 size-5 shrink-0 text-accent-ink" />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold">Import an existing chat</Dialog.Title>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Close import chat" disabled={importing} onClick={onClose}>
              <X className="size-4" />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <section
              className="flex min-h-0 max-h-[40%] shrink-0 flex-col border-b border-border sm:max-h-none sm:w-[340px] sm:border-b-0 sm:border-r"
              aria-label="Existing chats"
            >
              <div className="grid gap-2 border-b border-border p-3">
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Provider profile
                  <select
                    className={inputClass}
                    aria-label="History provider profile"
                    value={profileId}
                    disabled={importing}
                    onChange={(event) => {
                      setProfileId(event.target.value);
                      setArchived(false);
                    }}
                  >
                    {profiles.map((item) => (
                      <option key={item.providerInstanceId} value={item.providerInstanceId}>
                        {item.label} · {providerOption(item.kind).label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  <label className={cn(inputClass, 'flex flex-1 items-center gap-2')}>
                    <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    <input
                      className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                      aria-label="Search existing chats"
                      placeholder="Search chat history"
                      value={search}
                      disabled={importing}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Refresh history"
                    disabled={listLoading || importing}
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    <RefreshCw className={cn('size-4', listLoading && 'animate-spin')} />
                  </Button>
                </div>
                {profile?.kind === 'codex' ? (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={archived} disabled={importing} onChange={(event) => setArchived(event.target.checked)} />
                    Browse archived chats
                  </label>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={listLoading}>
                {!profileId ? <p className="p-3 text-sm text-muted-foreground">Add a Codex or Claude Code profile in Agents to browse its history.</p> : null}
                {listLoading ? (
                  <p className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground" role="status">
                    <LoaderCircle className="size-4 animate-spin" />
                    Loading history…
                  </p>
                ) : null}
                {listError ? (
                  <div className="m-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive" role="alert">
                    <p>{listError}</p>
                    <Button className="mt-2" variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>
                      Try again
                    </Button>
                  </div>
                ) : null}
                {!listLoading && profileId && !listError && sessions.length === 0 ? (
                  <p className="p-4 text-xs leading-5 text-muted-foreground">
                    {search.trim()
                      ? 'No matching chats. Try another search or provider profile.'
                      : 'No saved chats in this provider profile. Choose another profile or start a new chat.'}
                  </p>
                ) : null}
                {sessions.map((session) => (
                  <button
                    key={`${session.sourceKey}:${session.nativeSessionId}`}
                    type="button"
                    aria-pressed={selected?.nativeSessionId === session.nativeSessionId}
                    disabled={importing || listLoading}
                    onClick={() => setSelected(session)}
                    className={cn(
                      'mb-1 block w-full rounded-lg border border-transparent p-3 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50',
                      selected?.nativeSessionId === session.nativeSessionId && 'border-accent-ink/30 bg-accent-ink/8',
                    )}
                  >
                    <span className="flex items-start gap-2">
                      <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">{session.title || 'Untitled chat'}</span>
                      {session.importedSessionId ? (
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">In SessionFlow</span>
                      ) : null}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[10.5px] text-muted-foreground" title={session.cwd}>
                      {session.cwd || 'No saved project folder'}
                    </span>
                    {session.updatedAt ? <span className="mt-1 block text-[10px] text-muted-foreground">{formatTimestamp(session.updatedAt)}</span> : null}
                  </button>
                ))}
                {nextCursor ? (
                  <Button variant="ghost" className="mt-1 w-full" disabled={moreLoading || listLoading || importing} onClick={() => void loadMore()}>
                    {moreLoading ? 'Loading…' : 'Load more chats'}
                  </Button>
                ) : null}
                {listWarnings.map((warning) => (
                  <p key={warning} className="px-3 py-2 text-xs leading-5 text-term-amber">
                    {warning}
                  </p>
                ))}
              </div>
            </section>
            <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Chat history preview" aria-busy={previewLoading}>
              {!selected ? (
                <div className="m-auto max-w-xs p-8 text-center">
                  <History className="mx-auto mb-3 size-7 text-muted-foreground/60" />
                  <p className="text-sm font-medium">Select a chat to preview</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Browse history without starting a model. Import the chat when you are ready to continue it here.
                  </p>
                </div>
              ) : null}
              {previewLoading ? (
                <p className="m-auto flex items-center gap-2 p-8 text-xs text-muted-foreground" role="status">
                  <LoaderCircle className="size-4 animate-spin" />
                  Reading chat history…
                </p>
              ) : null}
              {previewError ? (
                <p className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive" role="alert">
                  {previewError}
                </p>
              ) : null}
              {details && !previewLoading ? (
                <>
                  <div className="border-b border-border px-5 py-3">
                    <h3 className="truncate text-sm font-semibold">{details.session.title || 'Untitled chat'}</h3>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={details.session.nativeSessionId}>
                      {providerOption(details.session.providerKind).label} · {details.session.nativeSessionId}
                    </p>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
                    {details.historyTruncated ? (
                      <p className="mb-3 rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">
                        Only recent saved history is shown and imported. Continuing keeps the full native session context.
                      </p>
                    ) : null}
                    {details.messages.length > previewMessages.length ? (
                      <p className="mb-3 text-xs text-muted-foreground">
                        Previewing the latest {previewMessages.length} of {details.messages.length} saved messages.
                      </p>
                    ) : null}
                    {previewMessages.length === 0 ? (
                      <p className="py-8 text-center text-xs text-muted-foreground">
                        No saved text messages. You can still continue this chat after importing.
                      </p>
                    ) : null}
                    {previewMessages.map((message, index) => (
                      <article key={`${message.id}:${index}`} className="border-b border-border/60 py-3 last:border-b-0">
                        <div className="mb-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className={cn('font-medium', message.role === 'user' && 'text-accent-ink')}>
                            {message.role === 'user' ? 'You' : message.role === 'system' ? 'System' : 'Assistant'}
                          </span>
                          {message.ts ? <span className="ml-auto">{formatTimestamp(message.ts)}</span> : null}
                        </div>
                        <div className="max-h-56 overflow-y-auto text-xs leading-5">
                          <AgentMarkdown text={message.content} />
                        </div>
                      </article>
                    ))}
                    {details.warnings?.map((warning) => (
                      <p key={warning} className="mt-3 text-xs leading-5 text-term-amber">
                        {warning}
                      </p>
                    ))}
                  </div>
                  <footer className="grid gap-3 border-t border-border bg-muted/20 px-5 py-4">
                    <label className="grid gap-1 text-xs text-muted-foreground">
                      Project folder
                      <div className="flex gap-2">
                        <input
                          className={cn(inputClass, 'flex-1 font-mono text-xs')}
                          aria-label="Import project folder"
                          value={cwd}
                          disabled={importing}
                          onChange={(event) => setCwd(event.target.value)}
                          placeholder="/path/to/project"
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Choose import project folder"
                          disabled={importing}
                          onClick={() => void chooseFolder()}
                        >
                          <FolderOpen className="size-4" />
                        </Button>
                      </div>
                      <span className="text-[10.5px] leading-5">Choose an existing folder if this project has moved.</span>
                    </label>
                    {details.session.archived ? (
                      <p className="text-xs leading-5 text-muted-foreground">
                        This chat is archived. Sending a message will unarchive it and continue the original chat.
                      </p>
                    ) : null}
                    {details.session.active && !details.session.importedSessionId ? (
                      <p className="text-xs text-term-amber">This chat is running. Finish its current turn in the original app before importing.</p>
                    ) : null}
                    {importError ? (
                      <p className="text-xs leading-5 text-destructive" role="alert">
                        {importError}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[10.5px] leading-5 text-muted-foreground">Importing starts no work. Send a message to continue the original chat.</p>
                      <Button
                        className="shrink-0"
                        disabled={importing || listLoading || (!details.session.importedSessionId && (!cwd.trim() || Boolean(details.session.active)))}
                        onClick={() => void importChat()}
                      >
                        {importing ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                        {importing ? 'Importing…' : details.session.importedSessionId ? 'Open in SessionFlow' : 'Import chat'}
                      </Button>
                    </div>
                  </footer>
                </>
              ) : null}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
