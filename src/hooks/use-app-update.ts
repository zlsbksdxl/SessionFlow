import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppUpdateState } from '@shared/app-update';

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>();
  const [actionError, setActionError] = useState<string>();
  const eventRevision = useRef(0);
  const actionRevision = useRef(0);

  useEffect(() => {
    const updates = window.orrery?.updates;
    if (!updates) return;

    let active = true;
    const unsubscribe = updates.onState((nextState) => {
      eventRevision.current += 1;
      if (active) setState(nextState);
    });
    const revision = eventRevision.current;
    void updates
      .getState()
      .then((nextState) => {
        if (active && eventRevision.current === revision) setState(nextState);
      })
      .catch((error: unknown) => {
        if (active) {
          setActionError(error instanceof Error ? error.message : 'Could not read update status.');
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const openReleasePage = useCallback(async () => {
    const revision = ++actionRevision.current;
    setActionError(undefined);
    try {
      await window.orrery?.updates.openReleasePage();
    } catch (error) {
      if (actionRevision.current === revision) setActionError(error instanceof Error ? error.message : 'Could not open the download page.');
    }
  }, []);

  const checkForUpdates = useCallback(async () => {
    const updates = window.orrery?.updates;
    if (!updates) return;
    setActionError(undefined);
    const revision = eventRevision.current;
    const action = ++actionRevision.current;
    try {
      const nextState = await updates.checkForUpdates();
      if (eventRevision.current === revision) setState(nextState);
    } catch (error) {
      if (actionRevision.current === action) setActionError(error instanceof Error ? error.message : 'Could not check for updates.');
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const updates = window.orrery?.updates;
    if (!updates) return;
    setActionError(undefined);
    const revision = eventRevision.current;
    const action = ++actionRevision.current;
    try {
      const nextState = await updates.installUpdate();
      if (eventRevision.current === revision) setState(nextState);
    } catch (error) {
      if (actionRevision.current === action) setActionError(error instanceof Error ? error.message : 'Could not install the update.');
    }
  }, []);

  return { state, actionError, openReleasePage, checkForUpdates, installUpdate };
}
