import { useEffect, useId, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { Popover, Slider } from 'radix-ui';
import { modelOptionsForKind, reasoningEffortOptionsForKind } from '@/lib/provider-catalog';
import { cn } from '@/lib/utils';
import type { ProviderSetupModel } from '@/shared/graph-state';
import { providerSupportsReasoningEffort, type ProviderKind, type ProviderReasoningEffort } from '@/shared/provider-runtime';

type ComposerModelControlsProps = {
  providerKind: ProviderKind;
  model: string;
  reasoningEffort: ProviderReasoningEffort;
  discoveredModels?: ProviderSetupModel[];
  currentModelId?: string;
  disabled?: boolean;
  normalizeReasoningEffort?: boolean;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ProviderReasoningEffort) => void;
};

function effortOptionsForModel(providerKind: ProviderKind, selectedModel?: ProviderSetupModel) {
  if (!providerSupportsReasoningEffort(providerKind) || selectedModel?.supportsReasoningEffort === false) return [];
  const options = reasoningEffortOptionsForKind(providerKind);
  return (selectedModel?.reasoningEfforts ? options.filter((option) => selectedModel.reasoningEfforts?.includes(option.id)) : options).map((option) => ({
    ...option,
    label: option.id === 'xhigh' ? 'Extra high' : option.label,
  }));
}

const triggerClassName =
  'inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-full px-2.5 text-[11.5px] transition hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-accent-hi/50 disabled:cursor-not-allowed disabled:opacity-50';

export function ComposerModelControls({
  providerKind,
  model,
  reasoningEffort,
  discoveredModels,
  currentModelId,
  disabled,
  normalizeReasoningEffort = true,
  onModelChange,
  onReasoningEffortChange,
}: ComposerModelControlsProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState(model);
  const customInputId = useId();
  const options = useMemo(
    () => discoveredModels?.map((entry) => ({ value: entry.modelId, label: entry.name })) ?? modelOptionsForKind(providerKind),
    [discoveredModels, providerKind],
  );
  const selectedModelId = model.trim();
  const selectedModel = discoveredModels?.find((entry) => entry.modelId === (selectedModelId || currentModelId));
  const modelLabel = selectedModelId ? (options.find((option) => option.value === selectedModelId)?.label ?? selectedModelId) : 'Default';
  const effectiveModelLabel = selectedModel?.name ?? (selectedModelId ? modelLabel : (currentModelId ?? modelLabel));
  const effortOptions = useMemo(() => effortOptionsForModel(providerKind, selectedModel), [providerKind, selectedModel]);
  const selectedEffortIndex = effortOptions.findIndex((option) => option.id === reasoningEffort);
  const selectedEffort = effortOptions[selectedEffortIndex];
  const defaultEffort = effortOptions.find((option) => option.id === 'medium') ?? effortOptions[0];
  const hasCustomModel = selectedModelId !== '' && !options.some((option) => option.value === selectedModelId);
  const accentedEffort = selectedEffort?.id === 'high' || selectedEffort?.id === 'xhigh';

  // A refreshed live catalog can narrow the supported levels without changing
  // the model ID. Keep the draft settings valid when that happens as well.
  useEffect(() => {
    if (!disabled && normalizeReasoningEffort && selectedEffortIndex < 0 && defaultEffort) onReasoningEffortChange(defaultEffort.id);
  }, [disabled, normalizeReasoningEffort, selectedEffortIndex, defaultEffort, onReasoningEffortChange]);

  useEffect(() => {
    if (disabled) {
      setModelOpen(false);
      setEffortOpen(false);
    }
  }, [disabled]);

  function chooseModel(nextModel: string) {
    if (disabled) return;
    const nextModelId = nextModel.trim();
    const nextCatalogModel = discoveredModels?.find((entry) => entry.modelId === (nextModelId || currentModelId));
    const nextEffortOptions = effortOptionsForModel(providerKind, nextCatalogModel);
    onModelChange(nextModelId);
    if (nextEffortOptions.length && !nextEffortOptions.some((option) => option.id === reasoningEffort)) {
      onReasoningEffortChange((nextEffortOptions.find((option) => option.id === 'medium') ?? nextEffortOptions[0]).id);
    }
  }

  function commitCustomModel() {
    if (disabled) return;
    if (customDraft.trim() !== selectedModelId) chooseModel(customDraft);
  }

  const modelPicker = (
    <Popover.Root
      open={modelOpen && !disabled}
      onOpenChange={(open) => {
        setModelOpen(open);
        if (open) {
          setCustomDraft(model);
          setCustomOpen(hasCustomModel);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="mx-auto mt-0.5 flex h-6 min-w-0 max-w-full items-center justify-center gap-0.5 rounded-md px-2 text-[11.5px] text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-term-accent-hi/50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          aria-label={`Select model: ${modelLabel}`}
          title={effectiveModelLabel}
        >
          <span className="truncate">{effectiveModelLabel}</span>
          <ChevronRight className="size-3 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="center"
          sideOffset={10}
          collisionPadding={12}
          aria-label="Select model"
          className="app-region-no-drag z-60 w-[280px] max-w-[calc(100vw-24px)] rounded-2xl bg-popover p-1.5 text-popover-foreground shadow-xl ring-1 ring-foreground/[0.04] outline-none"
        >
          <p className="px-2.5 py-1.5 text-xs text-muted-foreground">Select model</p>
          <div className="max-h-[min(320px,50vh)] space-y-0.5 overflow-y-auto">
            <button
              type="button"
              aria-pressed={!selectedModelId}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] outline-none hover:bg-muted focus-visible:bg-muted"
              onClick={() => {
                chooseModel('');
                setModelOpen(false);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block">Default</span>
                <span className="block text-[11px] text-muted-foreground">Provider default</span>
              </span>
              {!selectedModelId ? <Check className="size-3.5 shrink-0" /> : null}
            </button>
            {options
              .filter((option) => option.value !== '')
              .map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selectedModelId === option.value}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] outline-none hover:bg-muted focus-visible:bg-muted"
                  title={option.value}
                  onClick={() => {
                    chooseModel(option.value);
                    setModelOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selectedModelId === option.value ? <Check className="size-3.5 shrink-0" /> : null}
                </button>
              ))}
            <button
              type="button"
              aria-expanded={customOpen}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] outline-none hover:bg-muted focus-visible:bg-muted"
              onClick={() => {
                setCustomDraft(model);
                setCustomOpen(true);
              }}
            >
              <span className="flex-1">Custom…</span>
              {hasCustomModel ? <Check className="size-3.5 shrink-0" /> : null}
            </button>
          </div>
          {customOpen ? (
            <div className="px-2.5 pb-2 pt-2.5">
              <label htmlFor={customInputId} className="mb-1.5 block text-[11px] text-muted-foreground">
                Custom model ID
              </label>
              <input
                id={customInputId}
                autoFocus
                disabled={disabled}
                value={customDraft}
                placeholder="Enter model ID"
                className="h-8 w-full rounded-lg bg-muted px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-term-accent-hi/50"
                onChange={(event) => setCustomDraft(event.target.value)}
                onBlur={commitCustomModel}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitCustomModel();
                    setModelOpen(false);
                  }
                }}
              />
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );

  return (
    <div className="inline-flex min-w-0 max-w-full items-center rounded-full bg-muted/65 p-0.5">
      <Popover.Root
        open={effortOpen && !disabled}
        onOpenChange={(open) => {
          setEffortOpen(open);
          setModelOpen(false);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              triggerClassName,
              'max-w-52',
              accentedEffort ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground hover:text-foreground',
            )}
            disabled={disabled}
            aria-label={effortOptions.length ? `Reasoning effort: ${selectedEffort?.label ?? 'Select effort'}` : `Model settings: ${modelLabel}`}
            title={effortOptions.length ? selectedEffort?.label : modelLabel}
          >
            <span className="truncate">{effortOptions.length ? (selectedEffort?.label ?? 'Select effort') : modelLabel}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="end"
            sideOffset={10}
            collisionPadding={12}
            aria-label={effortOptions.length ? 'Reasoning effort settings' : 'Model settings'}
            className="app-region-no-drag relative z-50 w-[260px] max-w-[calc(100vw-24px)] rounded-2xl bg-popover px-3.5 pb-3.5 pt-3 text-popover-foreground shadow-xl ring-1 ring-foreground/[0.04] outline-none"
          >
            {effortOptions.length > 0 ? (
              <button
                type="button"
                className="absolute right-2.5 top-2.5 rounded-md p-1 text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-term-accent-hi/50"
                aria-label="Reset reasoning effort"
                title="Reset reasoning effort"
                onClick={() => {
                  if (defaultEffort) onReasoningEffortChange(defaultEffort.id);
                }}
              >
                <RotateCcw className="size-3.5" />
              </button>
            ) : null}
            <p className={cn('px-5 text-center text-[13px] font-medium', accentedEffort && 'text-violet-600 dark:text-violet-400')}>
              {effortOptions.length ? (selectedEffort?.label ?? 'Select effort') : 'Model'}
            </p>
            {modelPicker}
            {effortOptions.length > 0 ? (
              <Slider.Root
                className="relative mt-4 flex h-6 w-full touch-none select-none items-center"
                min={0}
                max={Math.max(1, effortOptions.length - 1)}
                step={1}
                value={[Math.max(0, selectedEffortIndex)]}
                disabled={effortOptions.length < 2}
                onValueChange={([index]) => {
                  const option = effortOptions[index];
                  if (option) onReasoningEffortChange(option.id);
                }}
              >
                <Slider.Track className="relative h-6 grow overflow-hidden rounded-full bg-foreground/[0.10]">
                  <Slider.Range className="absolute h-full rounded-full bg-violet-500/75" />
                  <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 inset-y-0 flex items-center justify-between">
                    {effortOptions.map((option) => (
                      <span key={option.id} className="size-1 rounded-full bg-foreground/25" />
                    ))}
                  </span>
                </Slider.Track>
                <Slider.Thumb
                  aria-label="Reasoning effort"
                  aria-valuetext={selectedEffort?.label ?? 'Select effort'}
                  className="block size-7 rounded-full border border-border/50 bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
                />
              </Slider.Root>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
