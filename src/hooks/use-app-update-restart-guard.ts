import { useEffect, useRef } from 'react';

/** Let the main process restart only after this window's unsaved work is settled. */
export function useAppUpdateRestartGuard(blockerReason: string | undefined) {
  const latestBlocker = useRef(blockerReason);
  latestBlocker.current = blockerReason;

  useEffect(() => {
    const updates = window.orrery?.updates;
    if (!updates?.onBeforeInstall) return;
    let frozenRoot: HTMLElement | undefined;
    let previousInert = false;
    const release = () => {
      if (!frozenRoot) return;
      frozenRoot.inert = previousInert;
      frozenRoot = undefined;
    };
    const freeze = () => {
      const root = document.getElementById('root');
      if (root && !frozenRoot) {
        previousInert = root.inert;
        root.inert = true;
        frozenRoot = root;
      }
    };
    const unsubscribePrepare = updates.onBeforeInstall(() => {
      const openDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], dialog[open]')].some(
        (dialog) => dialog.getClientRects().length > 0 && !dialog.closest('[data-app-update-details]'),
      );
      const unsavedText = [
        ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
          'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="password"], [contenteditable="true"]',
        ),
      ].some((editor) => {
        if (editor.closest('[data-app-update-details]')) return false;
        if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement)
          return !editor.disabled && !editor.readOnly && Boolean(editor.value.trim());
        return Boolean(editor.textContent?.trim());
      });
      const reason =
        latestBlocker.current ??
        (openDialog
          ? 'Finish or close the open dialog before the update restarts SessionFlow.'
          : unsavedText
            ? 'Send or clear unsaved text, or finish and close the open setup form before restarting SessionFlow.'
            : undefined);
      if (reason) {
        release();
        return { ready: false, reason };
      }
      // Freeze input synchronously before acknowledging, so a new draft cannot
      // arrive between the readiness check and the main process's save fence.
      freeze();
      return { ready: true };
    });
    const unsubscribeState = updates.onState((state) => {
      if (state.status === 'installing') freeze();
      else release();
    });
    return () => {
      unsubscribePrepare();
      unsubscribeState();
      release();
    };
  }, []);
}
