import { useEffect, useRef, useState } from 'react';
import { Clock3, Download, ExternalLink, LoaderCircle, RotateCw } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppUpdate } from '@/hooks/use-app-update';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const unit = bytes >= 1024 ** 3 ? 'GB' : 'MB';
  const size = bytes / (unit === 'GB' ? 1024 ** 3 : 1024 ** 2);
  return `${size.toFixed(1)} ${unit}`;
}

export function AppUpdateButton() {
  const { state, actionError, installUpdate, openReleasePage } = useAppUpdate();
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const installInFlightRef = useRef(false);
  const requestRevision = useRef(0);
  const status = state?.status;
  const active = status === 'downloading' || status === 'waiting-for-idle' || status === 'installing' || status === 'checking';
  const busy = starting || active || Boolean(state?.installRequested && status !== 'error');
  const error = localError || actionError || (status === 'error' ? state?.message || 'The update could not be completed.' : undefined);

  useEffect(() => {
    if (error && state?.availableVersion) setOpen(true);
  }, [error, state?.availableVersion]);

  useEffect(() => {
    if (status !== 'error') return;
    requestRevision.current += 1;
    installInFlightRef.current = false;
    setStarting(false);
  }, [status]);

  async function requestInstall() {
    if (!state?.installSupported || busy || installInFlightRef.current) return;
    installInFlightRef.current = true;
    const revision = ++requestRevision.current;
    setStarting(true);
    setLocalError(undefined);
    try {
      await installUpdate();
    } catch (cause) {
      if (requestRevision.current === revision) setLocalError(cause instanceof Error ? cause.message : 'Could not start the update.');
    } finally {
      if (requestRevision.current === revision) {
        installInFlightRef.current = false;
        setStarting(false);
      }
    }
  }

  async function openDownloadPage() {
    setLocalError(undefined);
    try {
      await openReleasePage();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Could not open the download page.');
    }
  }

  if (!state?.enabled || status === 'disabled' || status === 'up-to-date' || !state.availableVersion) return null;

  const progress = state.progress;
  const percent = progress && Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, Math.round(progress.percent))) : undefined;
  const label =
    status === 'installing'
      ? 'Restarting'
      : status === 'waiting-for-idle'
        ? 'Waiting'
        : status === 'downloading'
          ? percent === undefined
            ? 'Updating'
            : `${percent}%`
          : busy
            ? 'Updating'
            : error && state.installSupported
              ? 'Retry'
              : 'Update';
  const Icon = status === 'waiting-for-idle' ? Clock3 : busy ? LoaderCircle : error && state.installSupported ? RotateCw : Download;
  const errorTitle =
    state.errorStage === 'download'
      ? 'Download failed'
      : state.errorStage === 'prepare'
        ? 'Could not prepare the update'
        : state.errorStage === 'install'
          ? 'Installation failed'
          : 'Update failed';
  const description =
    starting && status === 'available'
      ? 'Starting the update…'
      : status === 'downloading'
        ? 'Downloading the update…'
        : status === 'waiting-for-idle'
          ? 'Waiting for tasks and unsaved drafts to be settled. Your chats will be saved before restart.'
          : status === 'installing'
            ? 'Restarting to install the update…'
            : status === 'downloaded'
              ? state.installRequested
                ? 'Download complete. Preparing to restart…'
                : 'The update is downloaded and ready to install.'
              : status === 'checking'
                ? 'Checking for updates…'
                : 'The update will download and install when chats are idle, then restart SessionFlow.';

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger
            asChild
            onClick={(event) => {
              // Keep the details open during an update; repeated clicks never queue another install.
              event.preventDefault();
              setOpen(true);
              if (state.installSupported && !busy) void requestInstall();
            }}
          >
            <button
              type="button"
              aria-label={`${error && state.installSupported ? 'Retry update' : 'Update'} SessionFlow to ${state.availableVersion}${busy ? `: ${label}` : ''}`}
              aria-busy={busy}
              className="app-region-no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Icon className={cn('size-3.5 shrink-0', busy && Icon === LoaderCircle && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
            </button>
          </Popover.Trigger>
        </TooltipTrigger>
        {!open ? (
          <TooltipContent side="top" sideOffset={8}>
            {label === 'Update' ? 'Update' : `Update · ${label}`}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          data-app-update-details=""
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="SessionFlow update"
          className="app-region-no-drag z-50 w-72 max-w-[calc(100vw-24px)] rounded-2xl border border-border/60 bg-popover p-4 text-popover-foreground shadow-lg outline-none"
        >
          <h3 className="text-sm font-medium tracking-normal">SessionFlow {state.availableVersion}</h3>
          <p className="mt-1 text-xs tracking-normal text-muted-foreground">Current version {state.currentVersion}</p>
          {state.installSupported ? (
            <p role="status" className="mt-3 text-xs leading-5 tracking-normal text-muted-foreground">
              {error ? 'Retry to continue the update.' : description}
            </p>
          ) : (
            <p className="mt-3 text-xs leading-5 tracking-normal text-muted-foreground">
              {state.supportMessage || 'Automatic installation is unavailable for this build. Download and install the update manually.'}
            </p>
          )}
          {status === 'downloading' ? (
            <div className="mt-3 space-y-1.5">
              <div
                role="progressbar"
                aria-label="Update download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={percent === undefined ? 'Downloading update' : `${percent}% downloaded`}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn('h-full rounded-full bg-accent-ink transition-[width]', percent === undefined && 'animate-pulse')}
                  style={{ width: percent === undefined ? '35%' : `${percent}%` }}
                />
              </div>
              <div className="flex justify-between gap-2 text-[11px] tabular-nums tracking-normal text-muted-foreground">
                <span>
                  {progress && progress.total > 0
                    ? `${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`
                    : percent === undefined
                      ? 'Downloading…'
                      : `${percent}%`}
                </span>
                {progress && progress.bytesPerSecond > 0 ? <span>{formatBytes(progress.bytesPerSecond)}/s</span> : null}
              </div>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="mt-3 space-y-1 text-xs leading-5 tracking-normal text-destructive">
              <p className="font-medium">{errorTitle}</p>
              <p className="break-words">{error}</p>
            </div>
          ) : null}
          {state.message && status !== 'error' && busy ? (
            <p className="mt-2 text-[11px] leading-4 tracking-normal text-muted-foreground">{state.message}</p>
          ) : null}
          {error && state.installSupported && !busy ? (
            <button
              type="button"
              onClick={() => void requestInstall()}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium tracking-normal text-background transition hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
              Retry update
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void openDownloadPage()}
            className="mt-3 flex items-center gap-1.5 rounded text-xs tracking-normal text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Open download page
            <ExternalLink className="size-3" aria-hidden="true" />
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
