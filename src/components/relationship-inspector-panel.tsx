import { useId, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Check, Link2, OctagonX, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { GraphEdgeData } from '@/lib/graph-view';
import type { GraphState, Subscription } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import { readRelationshipPrompt, relationshipPromptKey, writeRelationshipPrompt } from '@/lib/relationship-prompts';

function sourceLabel(state: GraphState, subscription: Subscription) {
  if (subscription.source.kind === 'session') return state.sessions[subscription.source.sessionId]?.label ?? subscription.source.sessionId;
  if (subscription.source.kind === 'cluster') return state.clusters[subscription.source.clusterId]?.label ?? subscription.source.clusterId;
  if (subscription.source.kind === 'external') return state.sources?.[subscription.source.sourceId]?.label ?? subscription.source.sourceId;
  return 'Clock';
}

function patternText(subscription: Subscription) {
  const on = subscription.on.on;
  if (on === 'report' && subscription.on.match) {
    return `report ${Object.values(subscription.on.match).join(' · ')}`;
  }
  if (on === 'external') return `external.${subscription.on.topic ?? 'event'}`;
  return on;
}

export function RelationshipInspectorPanel({
  data,
  runtimeState,
  runtimeApi,
  onClose,
  onStateChange,
  onError,
}: {
  data: GraphEdgeData;
  runtimeState: GraphState;
  runtimeApi: RuntimeApi | undefined;
  onClose: () => void;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
}) {
  const promptKey = relationshipPromptKey(data);
  return (
    <RelationshipInspectorContent key={promptKey ?? 'missing'} {...{ data, runtimeState, runtimeApi, onClose, onStateChange, onError }} promptKey={promptKey} />
  );
}

function RelationshipInspectorContent({
  data,
  runtimeState,
  runtimeApi,
  onClose,
  onStateChange,
  onError,
  promptKey,
}: Parameters<typeof RelationshipInspectorPanel>[0] & { promptKey: string | undefined }) {
  const promptId = useId();
  const previousFocusRef = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [savedPrompt, setSavedPrompt] = useState(() => (promptKey ? readRelationshipPrompt(promptKey) : ''));
  const [prompt, setPrompt] = useState(savedPrompt);
  const [promptError, setPromptError] = useState<string>();
  const [didSave, setDidSave] = useState(false);
  const subscription = data.subscriptionId ? runtimeState.subscriptions?.[data.subscriptionId] : undefined;
  const history = data.edgeId ? runtimeState.edges.find((edge) => edge.edgeId === data.edgeId) : undefined;
  const canEditPrompt = Boolean(promptKey && (subscription || history));
  const hasPromptChanges = prompt.trim() !== savedPrompt;
  const dynamicGroups =
    subscription?.action.kind === 'create'
      ? Object.values(runtimeState.dynamicSpawnGroups ?? {})
          .filter((group) => group.subscriptionId === subscription.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      : [];

  const stop = async () => {
    if (!runtimeApi || !subscription || subscription.state !== 'active') return;
    try {
      const result = await runtimeApi.stopSubscription({
        subscriptionId: subscription.id,
        reason: 'Stopped by the user from the Relationship inspector.',
      });
      onStateChange(result.state);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const savePrompt = () => {
    if (!promptKey || !canEditPrompt) return;
    try {
      writeRelationshipPrompt(promptKey, prompt);
      setSavedPrompt(prompt.trim());
      setPrompt(prompt.trim());
      setPromptError(undefined);
      setDidSave(true);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/15" />
        <Dialog.Content
          className="app-region-no-drag fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border border-foreground/10 bg-background text-foreground shadow-2xl focus:outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
          }}
        >
          <header className="flex shrink-0 items-center gap-2.5 px-5 pb-4 pt-5">
            <Link2 className="size-4 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">Relationship</Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-xs text-muted-foreground">
                {subscription?.label ?? history?.label ?? data.label}
              </Dialog.Description>
            </div>
            <Button variant="ghost" size="icon" aria-label="Close Relationship inspector" onClick={onClose}>
              <X className="size-3.5" />
            </Button>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5 text-xs">
            {subscription ? (
              <>
                <div className="grid grid-cols-[84px_1fr] gap-x-2 gap-y-2 rounded-lg border border-border bg-card p-2.5">
                  <span className="text-muted-foreground">From</span>
                  <span>{sourceLabel(runtimeState, subscription)}</span>
                  <span className="text-muted-foreground">When</span>
                  <span>{patternText(subscription)}</span>
                  <span className="text-muted-foreground">Then</span>
                  <span>
                    {subscription.action.kind.replaceAll('-', ' ')} →{' '}
                    {runtimeState.sessions[subscription.target.sessionId]?.label ?? subscription.target.sessionId}
                  </span>
                  <span className="text-muted-foreground">Delivery</span>
                  <span>
                    {subscription.action.kind === 'create' ? `template ${subscription.action.template.templateId}` : (subscription.action.topic ?? 'none')}
                  </span>
                  <span className="text-muted-foreground">Gate</span>
                  <span>
                    {subscription.gate} · {subscription.concurrency}
                  </span>
                  <span className="text-muted-foreground">State</span>
                  <span>
                    {subscription.state} · {subscription.firings}
                    {subscription.stop?.maxFirings ? `/${subscription.stop.maxFirings}` : ''} firings
                  </span>
                  <span className="text-muted-foreground">Stop when</span>
                  <span>
                    {subscription.stop?.whenReport?.verdict ? `report is ${subscription.stop.whenReport.verdict}` : ''}
                    {subscription.stop?.whenReport?.verdict && subscription.stop?.maxFirings ? ' or ' : ''}
                    {subscription.stop?.maxFirings ? `${subscription.stop.maxFirings} firings` : 'manually stopped'}
                  </span>
                </div>
                {subscription.action.kind !== 'create' && subscription.action.note ? (
                  <div className="rounded-lg border border-border bg-muted/35 p-2.5">
                    <div className="mb-1 text-[9.5px] tracking-[0.1em] text-muted-foreground">Instruction</div>
                    <p className="whitespace-pre-wrap leading-5">{subscription.action.note}</p>
                  </div>
                ) : null}
                {subscription.action.kind === 'create' ? (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/35 p-2.5">
                    <div className="text-[9.5px] tracking-[0.1em] text-muted-foreground">Dynamic topology</div>
                    <p className="leading-5">
                      Fixed template <span className="font-mono">{subscription.action.template.templateId}</span>
                      {' · '}fan-out ≤ {subscription.action.limits.maxFanOut}
                      {' · '}depth ≤ {subscription.action.limits.maxGenerationDepth}
                    </p>
                    {dynamicGroups.length === 0 ? (
                      <p className="text-muted-foreground">No issue report has created participants yet.</p>
                    ) : (
                      dynamicGroups.map((group) => (
                        <div key={group.groupId} className="rounded-md border border-border/70 bg-background/70 p-2 leading-5">
                          <div>
                            {group.status} · {group.createdCount}/{group.requestedCount} created
                          </div>
                          <div className="text-muted-foreground">
                            {group.skippedCount > 0 ? `${group.skippedCount} skipped · ` : ''}
                            Scope {group.scopeId} · generation {group.generationDepth}
                          </div>
                          {group.reason ? <p className="mt-1 text-amber-700 dark:text-amber-300">{group.reason}</p> : null}
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
                <Button className="w-full" variant="destructive" disabled={!runtimeApi || subscription.state !== 'active'} onClick={() => void stop()}>
                  <OctagonX className="size-3.5" />
                  {subscription.state === 'active' ? 'Stop automation' : 'Automation stopped'}
                </Button>
              </>
            ) : history ? (
              <>
                <div className="rounded-xl bg-muted/60 px-3 py-2.5 leading-5">
                  <div>
                    {runtimeState.sessions[history.source]?.label ?? history.source} → {runtimeState.sessions[history.target]?.label ?? history.target}
                  </div>
                  <div className="text-muted-foreground">
                    {history.kind.replaceAll('-', ' ')} · {new Date(history.ts).toLocaleString()}
                  </div>
                </div>
                {data.summary ? <p className="rounded-lg border border-border bg-muted/35 p-2.5 leading-5">{data.summary}</p> : null}
              </>
            ) : (
              <p className="text-muted-foreground">This Relationship is no longer present in the current graph state.</p>
            )}
            {canEditPrompt ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  savePrompt();
                }}
              >
                <label htmlFor={promptId} className="block text-xs font-medium">
                  Relationship prompt
                </label>
                <textarea
                  id={promptId}
                  value={prompt}
                  placeholder="Describe the relationship between these Agents…"
                  className="min-h-32 w-full resize-y rounded-xl border border-border bg-card px-3 py-2.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/65 focus-visible:border-foreground/25 focus-visible:ring-2 focus-visible:ring-foreground/10"
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setDidSave(false);
                    setPromptError(undefined);
                  }}
                />
                {promptError ? (
                  <p role="alert" className="text-xs leading-5 text-destructive">
                    {promptError}
                  </p>
                ) : null}
                <div className="flex items-center justify-end gap-3">
                  <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    {didSave && !hasPromptChanges ? (
                      <>
                        <Check className="size-3.5" aria-hidden="true" />
                        Saved
                      </>
                    ) : null}
                  </span>
                  <Button
                    type="submit"
                    disabled={!hasPromptChanges}
                    className="min-w-16 rounded-lg bg-foreground px-4 text-xs font-medium text-background hover:bg-foreground/90"
                  >
                    Save
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
