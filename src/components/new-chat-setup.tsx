import { useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, FolderOpen, GitBranch, RefreshCw, Settings, Sparkles, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive, Popover, Select as SelectPrimitive } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { ComposerProjectPicker } from '@/components/composer-project-picker';
import { ComposerComputerPicker } from '@/components/composer-computer-picker';
import type { ChatComputerOption } from '@/lib/chat-computers';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type OpenWorkspaceTarget, type WorkMode } from '@/shared/graph-state';
import type { ChatProject } from '@shared/chat-projects';
import { type ProviderKind } from '@/shared/provider-runtime';
import { workspaceOpenTargetOptions, workspaceOpenTargetOption, workspaceOpenTargetAvailable } from '@/lib/layout-prefs';
import { providerOptions, modelOptionsForKind, workModeOptions } from '@/lib/provider-catalog';
import { type ProjectCwdValidation, type NewChatProjectOption, projectNameFromCwd, uniqueStrings } from '@/lib/workspace';

export function ProviderSegmentedControl({
  value,
  disabled,
  className,
  onChange,
}: {
  value: ProviderKind;
  disabled?: boolean;
  className?: string;
  onChange: (value: ProviderKind) => void;
}) {
  return (
    <div className={cn('grid grid-cols-3 gap-1 rounded-lg border border-ink-line bg-ink p-1 font-mono', disabled && 'opacity-60', className)}>
      {providerOptions.map((option) => {
        const isSelected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            className={cn(
              'truncate rounded-md px-2 py-1.5 text-[10.5px] tracking-[0.06em] transition disabled:cursor-not-allowed',
              isSelected
                ? 'bg-term-accent/[0.12] text-term-accent ring-1 ring-term-accent/30'
                : 'text-term-dim hover:bg-foreground/[0.06] hover:text-term-name',
            )}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function ProjectCwdField({
  value,
  validation,
  disabled,
  onChange,
}: {
  value: string;
  validation: ProjectCwdValidation;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={cn(
        'flex h-8 min-w-0 items-center gap-2 rounded-md border border-ink-line bg-ink px-2.5 font-mono transition focus-within:border-term-accent-hi/55 focus-within:ring-1 focus-within:ring-term-accent-hi/25',
        !validation.ok && 'border-term-rose/45 focus-within:border-term-rose/70',
        disabled && 'opacity-55',
      )}
      title="Project folder"
    >
      <FolderOpen className="size-3.5 shrink-0 text-term-accent-hi" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[12px] text-term-name outline-none placeholder:text-term-faint disabled:cursor-not-allowed"
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder="/path/to/project"
        aria-label="Project folder path"
        aria-invalid={!validation.ok}
        onChange={(event) => onChange(event.target.value)}
      />
      {!validation.ok ? <TriangleAlert className="size-3.5 shrink-0 text-term-rose" /> : null}
    </label>
  );
}

export function ProjectCwdChip({
  value,
  validation,
  projects,
  disabled,
  onChange,
}: {
  value: string;
  validation: ProjectCwdValidation;
  projects: NewChatProjectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={cn(
        'relative flex h-7 w-56 min-w-0 shrink-0 items-center gap-1.5 rounded-md border bg-ink px-2 font-mono transition focus-within:ring-1',
        validation.ok
          ? 'border-ink-line focus-within:border-term-accent-hi/60 focus-within:ring-term-accent-hi/25'
          : 'border-term-rose/55 focus-within:border-term-rose/70 focus-within:ring-term-rose/25',
        disabled && 'opacity-55',
      )}
      title={validation.ok ? 'Project folder' : validation.message}
    >
      <FolderOpen className={cn('size-3.5 shrink-0', validation.ok ? 'text-term-accent-hi' : 'text-term-rose')} />
      <input
        list="orrery-project-suggestions"
        className="min-w-0 flex-1 bg-transparent text-[11.5px] text-term-name outline-none placeholder:text-term-faint disabled:cursor-not-allowed"
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder="/path/to/project"
        aria-label="Project folder path"
        aria-invalid={!validation.ok}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id="orrery-project-suggestions">
        {projects.map((project) => (
          <option key={project.id} value={project.cwd}>
            {project.name}
          </option>
        ))}
      </datalist>
    </label>
  );
}

export type SetupOption = { value: string; label: string; disabled?: boolean };

export function NewChatSetupPill({
  icon: Icon,
  label,
  value,
  options,
  placeholder,
  tone = 'primary',
  disabled,
  invalid,
  hint,
  className,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  options: SetupOption[];
  placeholder?: string;
  tone?: 'primary' | 'secondary' | 'context';
  disabled?: boolean;
  invalid?: boolean;
  hint?: string;
  className?: string;
  onChange: (value: string) => void;
}) {
  const primary = tone === 'primary';
  const context = tone === 'context';
  const display = options.find((option) => option.value === value)?.label ?? placeholder ?? label;
  return (
    <SelectPrimitive.Root value={value} disabled={disabled} onValueChange={onChange}>
      <SelectPrimitive.Trigger
        aria-label={label}
        title={hint ?? label}
        className={cn(
          'group relative flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md outline-none transition disabled:cursor-not-allowed disabled:opacity-55',
          context
            ? 'h-8 px-2 font-sans hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/30'
            : 'font-mono',
          !context &&
            (primary
              ? 'border border-ink-line bg-ink pl-2 pr-1.5 hover:border-ink-line-2 data-[state=open]:border-term-accent-hi/60 focus-visible:border-term-accent-hi/60 focus-visible:ring-1 focus-visible:ring-term-accent-hi/25'
              : 'border border-transparent px-1.5 hover:bg-white/[0.05] data-[state=open]:bg-white/[0.05] focus-visible:bg-white/[0.05]'),
          invalid && 'border-term-rose/55 data-[state=open]:border-term-rose/70 focus-visible:border-term-rose/70 focus-visible:ring-term-rose/25',
          className,
        )}
      >
        <Icon
          className={cn('size-3.5 shrink-0', invalid ? 'text-term-rose' : context ? 'text-foreground/70' : primary ? 'text-term-accent-hi' : 'text-term-dim2')}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            context ? 'text-xs text-foreground/85' : primary ? 'text-[11.5px] font-medium text-term-name' : 'text-[11.5px] text-term-dim',
          )}
        >
          {display}
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition-[opacity,transform] group-data-[state=open]:rotate-180',
              context
                ? 'text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100'
                : primary
                  ? 'text-term-dim2'
                  : 'text-term-faint',
            )}
          />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'app-region-no-drag z-50 max-h-[min(18rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)] overflow-hidden rounded-lg border p-1',
            context
              ? 'border-border/60 bg-popover font-sans text-popover-foreground shadow-lg'
              : 'border-ink-line bg-ink-soft font-mono shadow-[0_12px_32px_-8px_rgba(0,0,0,0.75)]',
          )}
        >
          <SelectPrimitive.Viewport className="flex flex-col gap-0.5">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-md pl-2.5 pr-7 text-xs outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-35',
                  context
                    ? 'text-popover-foreground data-[highlighted]:bg-muted data-[state=checked]:font-medium'
                    : 'h-7 text-[11.5px] text-term-dim data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-term-name data-[state=checked]:bg-term-accent-hi/10 data-[state=checked]:font-medium data-[state=checked]:text-term-name',
                )}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
                  <Check className={cn('size-3.5', !context && 'text-term-accent-hi')} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function OpenWorkspaceSplitButton({
  target,
  platform,
  disabled,
  pendingTarget,
  onOpen,
  onTargetChange,
}: {
  target: OpenWorkspaceTarget;
  platform?: string;
  disabled?: boolean;
  pendingTarget?: OpenWorkspaceTarget;
  onOpen: (target: OpenWorkspaceTarget) => void;
  onTargetChange: (target: OpenWorkspaceTarget) => void;
}) {
  const activeOption = workspaceOpenTargetOption(target);
  const ActiveIcon = activeOption.icon;
  const isOpening = Boolean(pendingTarget);
  const activeUnavailable = !workspaceOpenTargetAvailable(activeOption, platform);
  const mainDisabled = disabled || isOpening || activeUnavailable;

  return (
    <DropdownMenuPrimitive.Root>
      <div className="app-region-no-drag inline-flex h-7 shrink-0 overflow-hidden rounded-lg border border-border bg-background shadow-sm">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="h-7 rounded-none border-0 px-2 font-mono text-[10.5px] tracking-[0.06em]"
              variant="ghost"
              size="sm"
              disabled={mainDisabled}
              aria-label={`Open in ${activeOption.label}`}
              onClick={() => onOpen(target)}
            >
              {isOpening && pendingTarget === target ? <RefreshCw className="size-3.5 animate-spin" /> : <ActiveIcon className="size-3.5" />}
              <span className="hidden max-w-16 truncate @[34rem]:inline">{activeOption.label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{activeUnavailable ? `${activeOption.label} is unavailable on this platform` : `Open in ${activeOption.label}`}</TooltipContent>
        </Tooltip>
        <DropdownMenuPrimitive.Trigger asChild>
          <Button
            className="h-7 w-7 rounded-none border-0 border-l border-border bg-muted/70 px-0"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || isOpening}
            aria-label="Choose open target"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuPrimitive.Trigger>
      </div>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          side="bottom"
          sideOffset={8}
          className="z-50 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_18px_44px_-16px_rgba(0,0,0,0.55)] data-[side=bottom]:animate-in data-[side=bottom]:slide-in-from-top-1"
        >
          {workspaceOpenTargetOptions.map((option) => {
            const Icon = option.icon;
            const unavailable = !workspaceOpenTargetAvailable(option, platform);
            const selected = option.id === target;
            const pending = pendingTarget === option.id;

            return (
              <DropdownMenuPrimitive.Item
                key={option.id}
                disabled={disabled || isOpening || unavailable}
                className="relative flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 pr-8 text-[13px] outline-none transition data-[disabled]:pointer-events-none data-[disabled]:opacity-35 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                onSelect={() => {
                  onTargetChange(option.id);
                  onOpen(option.id);
                }}
              >
                {pending ? (
                  <RefreshCw className="size-4 shrink-0 animate-spin text-term-accent-hi" />
                ) : (
                  <Icon className={cn('size-4 shrink-0', selected ? 'text-term-accent-hi' : 'text-muted-foreground')} />
                )}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected ? <Check className="absolute right-2.5 size-3.5 text-term-accent-hi" /> : null}
              </DropdownMenuPrimitive.Item>
            );
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export const modelDefaultOptionValue = '__orrery_model_default__';

export const modelCustomOptionValue = '__orrery_model_custom__';

// Per-agent model picker: a curated dropdown (Default + presets) plus a
// "Custom…" option that reveals a free-text field for arbitrary model ids.

export function ModelPickerPill({
  providerKind,
  model,
  discoveredOptions,
  disabled,
  onChange,
}: {
  providerKind: ProviderKind;
  model: string;
  discoveredOptions?: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const options = discoveredOptions ?? modelOptionsForKind(providerKind);
  const trimmed = model.trim();
  const isCustomValue = trimmed !== '' && !options.some((option) => option.value === trimmed);
  const [forceCustom, setForceCustom] = useState(false);

  // Switching agent resets to the curated list (the parent also clears the
  // model so a Codex id can't leak into a Claude session).
  useEffect(() => {
    setForceCustom(false);
  }, [providerKind]);

  const showCustom = forceCustom || isCustomValue;
  const selectValue = showCustom ? modelCustomOptionValue : trimmed === '' ? modelDefaultOptionValue : trimmed;
  const selectOptions: SetupOption[] = [{ value: modelDefaultOptionValue, label: 'Default' }, ...options, { value: modelCustomOptionValue, label: 'Custom…' }];

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <NewChatSetupPill
        icon={Bot}
        label="Model"
        hint="Model (provider default if unset)"
        value={selectValue}
        options={selectOptions}
        disabled={disabled}
        className="w-32"
        onChange={(next) => {
          if (next === modelCustomOptionValue) {
            setForceCustom(true);
            return;
          }
          setForceCustom(false);
          onChange(next === modelDefaultOptionValue ? '' : next);
        }}
      />
      {showCustom ? (
        <input
          className="h-7 w-28 shrink-0 rounded-md border border-ink-line bg-ink px-2 text-[11.5px] font-medium text-term-name outline-none transition placeholder:text-term-faint focus-visible:border-term-accent-hi/60 focus-visible:ring-1 focus-visible:ring-term-accent-hi/25 disabled:cursor-not-allowed disabled:opacity-55"
          value={model}
          disabled={disabled}
          placeholder="Model ID"
          aria-label="Custom model ID"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}

export function NewChatSetupBar({
  projects,
  projectCwd,
  computers,
  computerId,
  remoteHost,
  outsideProject,
  projectName,
  registeredProjects = [],
  selectedProjectId,
  validation,
  providerKind,
  workMode,
  branch,
  disabled,
  onNoProject,
  onSelectProject,
  onNewProject,
  onNewRemoteProject,
  onComputerChange,
  onProviderKindChange,
  onWorkModeChange,
  onBranchChange,
}: {
  projects: NewChatProjectOption[];
  projectCwd: string;
  computers: ChatComputerOption[];
  computerId: string;
  remoteHost?: string;
  outsideProject: boolean;
  projectName?: string;
  registeredProjects?: ChatProject[];
  selectedProjectId?: string;
  validation: ProjectCwdValidation;
  providerKind: ProviderKind;
  workMode: WorkMode;
  branch: string;
  disabled?: boolean;
  onNoProject: () => void;
  onSelectProject: (project: ChatProject) => void;
  onNewProject: () => void;
  onNewRemoteProject: () => void;
  onComputerChange: (computerId: string) => void;
  onProviderKindChange: (providerKind: ProviderKind) => void;
  onWorkModeChange: (workMode: WorkMode) => void;
  onBranchChange: (branch: string) => void;
}) {
  const selectedProject = projects.find((project) => project.cwd === projectCwd.trim()) ?? projects[0];
  const branchOptions = uniqueStrings([selectedProject?.currentBranch, ...(selectedProject?.branches ?? [])]);
  const currentBranch = selectedProject?.currentBranch ?? branchOptions[0];
  const localBranchValue = currentBranch ?? '';
  const worktreeBranchValue = branch && branchOptions.includes(branch) ? branch : localBranchValue;
  const branchValue = workMode === 'worktree' ? worktreeBranchValue : localBranchValue;
  const isKnownNonGitProject = selectedProject?.isGitRepo === false;
  const canPickBranch = workMode === 'worktree' && branchOptions.length > 0;

  const projectChipRef = useRef<HTMLDivElement>(null);
  const selectedProjectName = outsideProject
    ? 'Choose project'
    : (projectName ??
      projects.find((project) => project.cwd === projectCwd.trim())?.name ??
      (projectCwd.trim() ? projectNameFromCwd(projectCwd) : 'Choose project'));
  const projectHint = outsideProject
    ? 'Choose a project for this chat'
    : validation.ok
      ? remoteHost
        ? `${remoteHost}:${projectCwd}`
        : projectCwd
      : validation.message;
  const changeWorkMode = (value: string) => {
    const nextMode = value === 'worktree' ? 'worktree' : 'local';
    onWorkModeChange(nextMode);
    if (nextMode === 'local') onBranchChange('');
  };
  const workOptions = workModeOptions.map((option) => ({
    value: option.id,
    label: option.id === 'local' ? 'Current folder' : 'Worktree',
    disabled: option.id === 'worktree' && (isKnownNonGitProject || Boolean(remoteHost)),
  }));
  const settingsFieldClass = 'grid min-w-0 gap-1.5';
  const settingsSelectClass = 'w-full bg-muted/55';

  return (
    <div
      role="toolbar"
      aria-label="Chat context"
      className="app-region-no-drag relative mx-3 -mb-3 flex min-w-0 items-center gap-1 rounded-t-[18px] bg-muted/55 px-2 pb-4 pt-1"
    >
      <div ref={projectChipRef} className="group/project relative flex min-w-0 max-w-[48%] shrink items-center rounded-md">
        <ComposerProjectPicker
          projects={registeredProjects}
          selectedProjectId={selectedProjectId}
          disabled={disabled}
          onSelectProject={onSelectProject}
          onNewProject={onNewProject}
          onNewRemoteProject={onNewRemoteProject}
          onClearProject={onNoProject}
        >
          <button
            type="button"
            disabled={disabled}
            aria-label={outsideProject ? 'Choose project' : 'Project'}
            title={projectHint}
            className={cn(
              'group flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-55',
              !outsideProject &&
                'group-hover/project:[&>svg:first-child]:opacity-0 group-has-[[data-project-remove]:focus-visible]/project:[&>svg:first-child]:opacity-0',
              outsideProject ? 'text-muted-foreground' : validation.ok ? 'text-foreground/85' : 'text-term-rose',
            )}
          >
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="truncate">{selectedProjectName}</span>
            {!outsideProject ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100" />
            ) : null}
          </button>
        </ComposerProjectPicker>
        {!outsideProject ? (
          <button
            type="button"
            aria-label="Remove project from this chat"
            data-project-remove=""
            title="Remove project from this chat"
            disabled={disabled}
            className="pointer-events-none absolute left-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground opacity-0 transition hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:text-muted-foreground/40 group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onNoProject();
              requestAnimationFrame(() => projectChipRef.current?.querySelector('button')?.focus());
            }}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <NewChatSetupPill
        icon={Sparkles}
        label="Agent"
        hint="Choose an agent"
        value={providerKind}
        tone="context"
        options={providerOptions.map((option) => ({ value: option.id, label: option.label }))}
        disabled={disabled}
        className="min-w-0 shrink"
        onChange={(next) => onProviderKindChange(next as ProviderKind)}
      />

      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Chat settings"
            title={`Chat settings · ${providerOptions.find((option) => option.id === providerKind)?.label ?? providerKind}`}
            className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition hover:bg-foreground/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-55"
          >
            <Settings className="size-3.5" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            aria-label="Chat settings"
            className="app-region-no-drag z-50 w-72 max-w-[calc(100vw-24px)] rounded-2xl border border-border/60 bg-popover p-4 text-popover-foreground shadow-lg outline-none"
          >
            <h3 className="mb-3 text-sm font-semibold">Chat settings</h3>
            <div className="grid gap-3">
              <div className={settingsFieldClass}>
                <span className="text-xs text-muted-foreground">Computer</span>
                <ComposerComputerPicker
                  computers={computers}
                  value={computerId}
                  disabled={disabled}
                  onChange={onComputerChange}
                  onNewRemoteProject={onNewRemoteProject}
                />
              </div>
              {!remoteHost ? (
                <div className={settingsFieldClass}>
                  <span className="text-xs text-muted-foreground">Work mode</span>
                  <NewChatSetupPill
                    icon={workMode === 'worktree' ? GitBranch : FolderOpen}
                    label="Work mode"
                    value={workMode}
                    tone="context"
                    options={workOptions}
                    disabled={disabled}
                    className={settingsSelectClass}
                    onChange={changeWorkMode}
                  />
                </div>
              ) : null}
              {!remoteHost && branchOptions.length > 0 ? (
                <div className={settingsFieldClass}>
                  <span className="text-xs text-muted-foreground">{canPickBranch ? 'Base branch' : 'Current branch'}</span>
                  <NewChatSetupPill
                    icon={GitBranch}
                    label="Branch"
                    value={branchValue}
                    placeholder="Branch"
                    tone="context"
                    options={branchOptions.map((option) => ({ value: option, label: option }))}
                    disabled={disabled || !canPickBranch}
                    className={settingsSelectClass}
                    onChange={onBranchChange}
                  />
                </div>
              ) : null}
              <p className="break-words text-[11px] leading-4 text-muted-foreground" title={remoteHost ? `${remoteHost}:${projectCwd}` : projectCwd}>
                {projectCwd ? (remoteHost ? `${remoteHost}:${projectCwd}` : projectCwd) : 'No working folder selected'}
              </p>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
