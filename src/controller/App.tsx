import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BG_EVENT,
  CONTROLLER_TO_BG,
  ROUTE_COMMAND,
  TAB_SCAN_SCOPE,
  type CandidateTab,
  type ControllerResponse,
  type ControllerToBackgroundMessage,
  type ErrorResponse,
  type RouteCommand,
  type RouteCommandArgs,
  type RouteSnapshot,
  type RouteState,
  type SessionSnapshot,
  type TabScanScope,
} from '../shared/protocol.js';

interface ViewState {
  candidates: CandidateTab[];
  session: SessionSnapshot;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isErrorResponse(response: ControllerResponse): response is ErrorResponse {
  return !response.ok;
}

function isRouteState(value: unknown): value is RouteState {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.routeId === 'string' &&
    typeof value.tabId === 'number' &&
    typeof value.windowId === 'number' &&
    typeof value.tabTitle === 'string' &&
    typeof value.videoTitle === 'string' &&
    typeof value.url === 'string' &&
    typeof value.offsetSec === 'number' &&
    typeof value.status === 'string' &&
    typeof value.currentTimeSec === 'number' &&
    (typeof value.durationSec === 'number' || value.durationSec === null) &&
    (isObjectRecord(value.lastSnapshot) || value.lastSnapshot === null) &&
    (typeof value.lastError === 'string' || value.lastError === null) &&
    typeof value.importedAtMs === 'number' &&
    typeof value.updatedAtMs === 'number'
  );
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isObjectRecord(value) || !Array.isArray(value.routes)) {
    return false;
  }

  return (
    (typeof value.mainRouteId === 'string' || value.mainRouteId === null) &&
    (typeof value.soloRouteId === 'string' || value.soloRouteId === null) &&
    value.routes.every(isRouteState)
  );
}

function isControllerResponse(value: unknown): value is ControllerResponse {
  if (!isObjectRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }

  if (!value.ok) {
    return typeof value.error === 'string';
  }

  return true;
}

function normalizeOffsetSeconds(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '--:--';
  }

  const safe = Math.max(0, Math.floor(seconds));
  const min = Math.floor(safe / 60);
  const sec = safe % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function parseTimeInputToSeconds(rawInput: string): number | null {
  const trimmed = rawInput.trim();

  if (!trimmed) {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const segments = trimmed.split(':');
  if (segments.length !== 2 && segments.length !== 3) {
    return null;
  }

  const values = segments.map((segment) => Number(segment));
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }

  const [a, b, c] = values;

  if (segments.length === 2) {
    return a * 60 + b;
  }

  return a * 3600 + b * 60 + (c ?? 0);
}

function parseOffsetInputToSeconds(rawInput: string): number | null {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  let sign = 1;
  let body = trimmed;

  if (body.startsWith('+')) {
    body = body.slice(1);
  } else if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1);
  }

  if (!body) {
    return null;
  }

  const absoluteSeconds = parseTimeInputToSeconds(body);
  if (absoluteSeconds === null) {
    return null;
  }

  return normalizeOffsetSeconds(sign * absoluteSeconds);
}

function resolveReferenceRoute(session: SessionSnapshot): RouteState | null {
  const { routes, mainRouteId } = session;
  if (routes.length === 0) {
    return null;
  }

  if (typeof mainRouteId === 'string') {
    const mainRoute = routes.find((route) => route.routeId === mainRouteId);
    if (mainRoute) {
      return mainRoute;
    }
  }

  return routes[0] ?? null;
}

function sendToBackground(message: ControllerToBackgroundMessage): Promise<ControllerResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!isControllerResponse(response)) {
        reject(new Error('Malformed response from background.'));
        return;
      }

      resolve(response);
    });
  });
}

const INITIAL_VIEW_STATE: ViewState = {
  candidates: [],
  session: {
    mainRouteId: null,
    soloRouteId: null,
    routes: [],
  },
};

export default function App() {
  const [viewState, setViewState] = useState<ViewState>(INITIAL_VIEW_STATE);
  const [statusText, setStatusText] = useState('Ready.');
  const [scanScope, setScanScope] = useState<TabScanScope>(TAB_SCAN_SCOPE.ALL_WINDOWS);
  const [seekAllInput, setSeekAllInput] = useState('');
  const [routeOffsetDrafts, setRouteOffsetDrafts] = useState<Record<string, string>>({});
  const [editingRouteOffsets, setEditingRouteOffsets] = useState<Record<string, boolean>>({});

  const setStatus = useCallback((text: string): void => {
    setStatusText(text);
  }, []);

  const applySessionSnapshot = useCallback((session: SessionSnapshot): void => {
    setViewState((prev) => ({
      ...prev,
      session,
    }));
  }, []);

  const refreshSession = useCallback(async (): Promise<void> => {
    const response = await sendToBackground({ type: CONTROLLER_TO_BG.GET_SESSION });

    if (isErrorResponse(response)) {
      throw new Error(response.error);
    }

    if (!('session' in response)) {
      throw new Error('Unexpected session response shape.');
    }

    applySessionSnapshot(response.session);
  }, [applySessionSnapshot]);

  const handleRouteCommand = useCallback(
    async (routeId: string, command: RouteCommand, args: RouteCommandArgs = {}): Promise<RouteSnapshot | null> => {
      const response = await sendToBackground({
        type: CONTROLLER_TO_BG.ROUTE_COMMAND,
        payload: {
          routeId,
          command,
          args,
        },
      });

      if (isErrorResponse(response)) {
        throw new Error(response.error);
      }

      if (!('snapshot' in response)) {
        throw new Error('Unexpected route command response shape.');
      }

      return response.snapshot;
    },
    [],
  );

  const handleScanTabs = useCallback(
    async (scope: TabScanScope): Promise<void> => {
      try {
        setStatus('Scanning YouTube watch tabs...');

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.LIST_YOUTUBE_TABS,
          payload: {
            scope,
          },
        });

        if (isErrorResponse(response)) {
          throw new Error(response.error);
        }

        if (!('tabs' in response)) {
          throw new Error('Unexpected tab list response shape.');
        }

        setViewState((prev) => ({
          ...prev,
          candidates: response.tabs,
        }));

        setStatus(`Scanned ${response.tabs.length} tab(s).`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Scan failed.'));
      }
    },
    [setStatus],
  );

  const handleImportTab = useCallback(
    async (tabId: number): Promise<void> => {
      try {
        setStatus(`Importing tab ${tabId}...`);

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.IMPORT_TAB,
          payload: { tabId },
        });

        if (isErrorResponse(response)) {
          throw new Error(response.error);
        }

        await refreshSession();

        const alreadyImported = 'alreadyImported' in response && response.alreadyImported === true;
        setStatus(alreadyImported ? `Tab ${tabId} already imported.` : `Tab ${tabId} imported.`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Import failed.'));
      }
    },
    [refreshSession, setStatus],
  );

  const handleRemoveRoute = useCallback(
    async (routeId: string): Promise<void> => {
      try {
        setStatus(`Removing route ${routeId}...`);

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.REMOVE_ROUTE,
          payload: { routeId },
        });

        if (isErrorResponse(response)) {
          throw new Error(response.error);
        }

        await refreshSession();
        setStatus(`Route ${routeId} removed.`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Remove route failed.'));
      }
    },
    [refreshSession, setStatus],
  );

  const handleSetMainRoute = useCallback(
    async (routeId: string): Promise<void> => {
      try {
        setStatus(`Switching main route to ${routeId}...`);

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.SET_MAIN_ROUTE,
          payload: { routeId },
        });

        if (isErrorResponse(response)) {
          throw new Error(response.error);
        }

        if (!('session' in response) || !isSessionSnapshot(response.session)) {
          throw new Error('Unexpected set-main-route response shape.');
        }

        applySessionSnapshot(response.session);
        setStatus(`Main route switched to ${routeId}. Offsets converted equivalently.`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Set main route failed.'));
      }
    },
    [applySessionSnapshot, setStatus],
  );

  const handleSetRouteOffset = useCallback(
    async (routeId: string, offsetSec: number): Promise<void> => {
      try {
        const normalizedOffset = normalizeOffsetSeconds(offsetSec);
        setStatus(`Updating offset for ${routeId} to ${normalizedOffset.toFixed(2)}s...`);

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.SET_ROUTE_OFFSET,
          payload: {
            routeId,
            offsetSec: normalizedOffset,
          },
        });

        if (isErrorResponse(response)) {
          throw new Error(response.error);
        }

        if (!('session' in response) || !isSessionSnapshot(response.session)) {
          throw new Error('Unexpected set-route-offset response shape.');
        }

        setRouteOffsetDrafts((prev) => ({
          ...prev,
          [routeId]: normalizedOffset.toFixed(2),
        }));

        applySessionSnapshot(response.session);
        setStatus(`Offset updated for ${routeId}: ${normalizedOffset.toFixed(2)}s.`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Set route offset failed.'));
      }
    },
    [applySessionSnapshot, setStatus],
  );

  const seekAllToTarget = useCallback(
    async (baseTimeSec: number, actionLabel: string): Promise<void> => {
      const routes = viewState.session.routes;
      if (routes.length === 0) {
        setStatus('No routes in session.');
        return;
      }

      setStatus(`${actionLabel}: seeking ${routes.length} route(s)...`);

      const results = await Promise.allSettled(
        routes.map((route) => {
          const targetTimeSec = Math.max(0, baseTimeSec + route.offsetSec);
          return handleRouteCommand(route.routeId, ROUTE_COMMAND.SEEK, { timeSec: targetTimeSec });
        }),
      );

      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedCount = results.length - successCount;

      await refreshSession();

      if (failedCount === 0) {
        setStatus(`${actionLabel}: completed for all routes.`);
        return;
      }

      setStatus(`${actionLabel}: ${successCount} success, ${failedCount} failed.`);
    },
    [handleRouteCommand, refreshSession, setStatus, viewState.session.routes],
  );

  const runAllRoutesCommand = useCallback(
    async (command: RouteCommand): Promise<void> => {
      const routes = viewState.session.routes;

      if (routes.length === 0) {
        setStatus('No routes in session.');
        return;
      }

      setStatus(`Running ${command} for ${routes.length} route(s)...`);

      const results = await Promise.allSettled(
        routes.map((route) => handleRouteCommand(route.routeId, command)),
      );

      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedCount = results.length - successCount;

      await refreshSession();

      if (failedCount === 0) {
        setStatus(`Command ${command} finished for all routes.`);
        return;
      }

      setStatus(`Command ${command}: ${successCount} success, ${failedCount} failed.`);
    },
    [handleRouteCommand, refreshSession, setStatus, viewState.session.routes],
  );

  const runSeekAll = useCallback(async (): Promise<void> => {
    const parsedSeconds = parseTimeInputToSeconds(seekAllInput);

    if (parsedSeconds === null) {
      setStatus('Seek target invalid. Use seconds, mm:ss, or hh:mm:ss.');
      return;
    }

    await seekAllToTarget(parsedSeconds, 'Seek All');
  }, [seekAllInput, seekAllToTarget, setStatus]);

  const runSyncNow = useCallback(async (): Promise<void> => {
    const referenceRoute = resolveReferenceRoute(viewState.session);

    if (!referenceRoute) {
      setStatus('No routes in session.');
      return;
    }

    const snapshot = await handleRouteCommand(referenceRoute.routeId, ROUTE_COMMAND.GET_STATUS);
    const referenceCurrentTimeSec = snapshot?.currentTimeSec ?? referenceRoute.currentTimeSec;

    if (!Number.isFinite(referenceCurrentTimeSec)) {
      setStatus('Sync Now failed: reference route time is unavailable.');
      return;
    }

    const masterTimeSec = referenceCurrentTimeSec - referenceRoute.offsetSec;
    await seekAllToTarget(masterTimeSec, 'Sync Now');
  }, [handleRouteCommand, seekAllToTarget, setStatus, viewState.session.mainRouteId, viewState.session.routes]);

  const runReadOffsets = useCallback(async (): Promise<void> => {
    const { routes } = viewState.session;
    const referenceRoute = resolveReferenceRoute(viewState.session);

    if (!referenceRoute) {
      setStatus('No routes in session.');
      return;
    }

    setStatus(`Read Offsets: reading current time from ${routes.length} route(s)...`);

    const statusResults = await Promise.allSettled(
      routes.map(async (route) => {
        const snapshot = await handleRouteCommand(route.routeId, ROUTE_COMMAND.GET_STATUS);
        const rawCurrentTimeSec = snapshot?.currentTimeSec;

        if (!Number.isFinite(rawCurrentTimeSec)) {
          throw new Error('Current time unavailable.');
        }

        const currentTimeSec = rawCurrentTimeSec as number;

        return {
          routeId: route.routeId,
          currentTimeSec,
        };
      }),
    );

    const currentTimeByRouteId = new Map<string, number>();
    statusResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        currentTimeByRouteId.set(result.value.routeId, result.value.currentTimeSec);
      }
    });

    const referenceCurrentTimeSec = currentTimeByRouteId.get(referenceRoute.routeId);
    if (typeof referenceCurrentTimeSec !== 'number') {
      await refreshSession();
      setStatus('Read Offsets failed: reference route status unavailable.');
      return;
    }

    // Keep the existing reference offset and derive a shared master time from it.
    const masterTimeSec = referenceCurrentTimeSec - referenceRoute.offsetSec;

    const targetOffsetUpdates = routes.flatMap((route) => {
      const currentTimeSec = currentTimeByRouteId.get(route.routeId);
      if (typeof currentTimeSec !== 'number') {
        return [];
      }

      return [
        {
          routeId: route.routeId,
          offsetSec: normalizeOffsetSeconds(currentTimeSec - masterTimeSec),
        },
      ];
    });

    const writeResults = await Promise.allSettled(
      targetOffsetUpdates.map(async (update) => {
        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.SET_ROUTE_OFFSET,
          payload: update,
        });

        if (isErrorResponse(response)) {
          throw new Error(response.error);
        }

        if (!('session' in response) || !isSessionSnapshot(response.session)) {
          throw new Error('Unexpected set-route-offset response shape.');
        }
      }),
    );

    const readFailedCount = routes.length - targetOffsetUpdates.length;
    const writeSuccessCount = writeResults.filter((result) => result.status === 'fulfilled').length;
    const writeFailedCount = targetOffsetUpdates.length - writeSuccessCount;

    await refreshSession();

    if (readFailedCount === 0 && writeFailedCount === 0) {
      setStatus(`Read Offsets: updated all ${routes.length} route(s).`);
      return;
    }

    setStatus(
      `Read Offsets: updated ${writeSuccessCount}/${routes.length}. read failed ${readFailedCount}, write failed ${writeFailedCount}.`,
    );
  }, [handleRouteCommand, refreshSession, setStatus, viewState.session]);

  useEffect(() => {
    setRouteOffsetDrafts((prev) => {
      const next: Record<string, string> = {};

      viewState.session.routes.forEach((route) => {
        const key = route.routeId;
        const routeCanonical = normalizeOffsetSeconds(route.offsetSec).toFixed(2);
        next[key] = editingRouteOffsets[key] ? (prev[key] ?? routeCanonical) : routeCanonical;
      });

      return next;
    });
  }, [editingRouteOffsets, viewState.session.routes]);

  useEffect(() => {
    const runtimeListener = (message: unknown): void => {
      if (!isObjectRecord(message) || typeof message.type !== 'string') {
        return;
      }

      switch (message.type) {
        case BG_EVENT.SESSION_UPDATED:
          if (!isObjectRecord(message.payload) || !isSessionSnapshot(message.payload.session)) {
            return;
          }

          applySessionSnapshot(message.payload.session);
          return;

        case BG_EVENT.ROUTE_INVALIDATED: {
          if (!isObjectRecord(message.payload)) {
            return;
          }

          const routeId = typeof message.payload.routeId === 'string' ? message.payload.routeId : '';
          setStatus(routeId ? `Route invalidated: ${routeId}` : 'Route invalidated.');

          void refreshSession().catch(() => {
            // Ignore secondary refresh errors.
          });
          return;
        }

        default:
          return;
      }
    };

    chrome.runtime.onMessage.addListener(runtimeListener);
    return () => {
      chrome.runtime.onMessage.removeListener(runtimeListener);
    };
  }, [applySessionSnapshot, refreshSession, setStatus]);

  useEffect(() => {
    void (async () => {
      try {
        const hello = await sendToBackground({ type: CONTROLLER_TO_BG.HELLO });

        if (isErrorResponse(hello)) {
          throw new Error(hello.error);
        }

        if (!('version' in hello)) {
          throw new Error('Unexpected hello response shape.');
        }

        await refreshSession();
        await handleScanTabs(TAB_SCAN_SCOPE.ALL_WINDOWS);

        setStatus(`Connected. Extension v${hello.version}.`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Initialization failed.'));
      }
    })();
  }, [handleScanTabs, refreshSession, setStatus]);

  const importedTabIds = useMemo(
    () => new Set(viewState.session.routes.map((route) => route.tabId)),
    [viewState.session.routes],
  );

  return (
    <main className="app">
      <header className="header">
        <h1>Archive Sync Controller</h1>
        <p className="subtitle">TabSync Mode - MVP Bootstrap</p>
      </header>

      <section className="panel">
        <h2>Tab Scan</h2>
        <div className="row">
          <label htmlFor="scanScope">Scope</label>
          <select
            id="scanScope"
            value={scanScope}
            onChange={(event) => setScanScope(event.target.value as TabScanScope)}
          >
            <option value={TAB_SCAN_SCOPE.ALL_WINDOWS}>All Windows</option>
            <option value={TAB_SCAN_SCOPE.CURRENT_WINDOW}>Current Window</option>
          </select>
          <button type="button" onClick={() => void handleScanTabs(scanScope)}>
            Scan
          </button>
        </div>
        <ul className="list">
          {viewState.candidates.length === 0 ? (
            <li className="empty">No candidate tabs.</li>
          ) : (
            viewState.candidates.map((tab) => {
              const isImported = importedTabIds.has(tab.tabId);

              return (
                <li key={tab.tabId} className="card">
                  <div className="card-head">
                    <p className="title">{tab.title || '(Untitled tab)'}</p>
                    <button
                      type="button"
                      disabled={isImported}
                      onClick={() => {
                        void handleImportTab(tab.tabId);
                      }}
                    >
                      {isImported ? 'Imported' : 'Import'}
                    </button>
                  </div>
                  <p className="meta">{`tab:${tab.tabId} | window:${tab.windowId} | ${tab.url}`}</p>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <section className="panel">
        <h2>Session Routes</h2>
        <div className="row controls-row">
          <button
            type="button"
            onClick={() => {
              void refreshSession()
                .then(() => {
                  setStatus('Session refreshed.');
                })
                .catch((error) => {
                  setStatus(toErrorMessage(error, 'Refresh failed.'));
                });
            }}
          >
            Refresh Session
          </button>
          <button
            type="button"
            onClick={() => {
              void runAllRoutesCommand(ROUTE_COMMAND.PLAY).catch((error) => {
                setStatus(toErrorMessage(error, 'Play all failed.'));
              });
            }}
          >
            Play All
          </button>
          <button
            type="button"
            onClick={() => {
              void runAllRoutesCommand(ROUTE_COMMAND.PAUSE).catch((error) => {
                setStatus(toErrorMessage(error, 'Pause all failed.'));
              });
            }}
          >
            Pause All
          </button>
          <input
            type="text"
            placeholder="Seek target: ss / mm:ss / hh:mm:ss"
            value={seekAllInput}
            onChange={(event) => setSeekAllInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void runSeekAll().catch((error) => {
                  setStatus(toErrorMessage(error, 'Seek all failed.'));
                });
              }
            }}
          />
          <button
            type="button"
            onClick={() => {
              void runSeekAll().catch((error) => {
                setStatus(toErrorMessage(error, 'Seek all failed.'));
              });
            }}
          >
            Seek All
          </button>
          <button
            type="button"
            onClick={() => {
              void runSyncNow().catch((error) => {
                setStatus(toErrorMessage(error, 'Sync now failed.'));
              });
            }}
          >
            Sync Now
          </button>
          <button
            type="button"
            onClick={() => {
              void runReadOffsets().catch((error) => {
                setStatus(toErrorMessage(error, 'Read offsets failed.'));
              });
            }}
          >
            Read Offsets
          </button>
        </div>

        <ul className="list">
          {viewState.session.routes.length === 0 ? (
            <li className="empty">No imported routes.</li>
          ) : (
            viewState.session.routes.map((route) => {
              const isMainRoute = route.routeId === viewState.session.mainRouteId;
              const routeOffsetValue =
                routeOffsetDrafts[route.routeId] ?? normalizeOffsetSeconds(route.offsetSec).toFixed(2);

              return (
                <li key={route.routeId} className={`card${isMainRoute ? ' main-route' : ''}`}>
                  <div className="card-head">
                    <p className="title">
                      {route.videoTitle || route.tabTitle || '(Unknown title)'}
                      {isMainRoute ? <span className="main-badge">MAIN</span> : null}
                    </p>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        void handleRemoveRoute(route.routeId);
                      }}
                    >
                      Remove
                    </button>
                  </div>

                  <p className="meta">
                    {[
                      `route:${route.routeId}`,
                      `tab:${route.tabId}`,
                      `status:${route.status}`,
                      `time:${formatTime(route.currentTimeSec)}`,
                      `offset:${normalizeOffsetSeconds(route.offsetSec).toFixed(2)}s`,
                    ].join(' | ')}
                  </p>

                  <div className="offset-controls">
                    <input
                      type="text"
                      className="offset-input"
                      inputMode="decimal"
                      placeholder="offset sec"
                      title="Supports signed seconds or signed mm:ss / hh:mm:ss"
                      value={routeOffsetValue}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setRouteOffsetDrafts((prev) => ({
                          ...prev,
                          [route.routeId]: nextValue,
                        }));
                      }}
                      onFocus={() => {
                        setEditingRouteOffsets((prev) => ({
                          ...prev,
                          [route.routeId]: true,
                        }));
                      }}
                      onBlur={() => {
                        const canonical = normalizeOffsetSeconds(route.offsetSec).toFixed(2);

                        setEditingRouteOffsets((prev) => ({
                          ...prev,
                          [route.routeId]: false,
                        }));
                        setRouteOffsetDrafts((prev) => ({
                          ...prev,
                          [route.routeId]: canonical,
                        }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();

                          const parsedOffset = parseOffsetInputToSeconds(routeOffsetValue);
                          if (parsedOffset === null) {
                            setStatus('Offset invalid. Use signed seconds, mm:ss, or hh:mm:ss.');
                            return;
                          }

                          void handleSetRouteOffset(route.routeId, parsedOffset);
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const parsedOffset = parseOffsetInputToSeconds(routeOffsetValue);
                        if (parsedOffset === null) {
                          setStatus('Offset invalid. Use signed seconds, mm:ss, or hh:mm:ss.');
                          return;
                        }

                        void handleSetRouteOffset(route.routeId, parsedOffset);
                      }}
                    >
                      Apply Offset
                    </button>

                    <div className="offset-step-actions">
                      {[
                        { label: '-1s', delta: -1 },
                        { label: '-0.1s', delta: -0.1 },
                        { label: '+0.1s', delta: 0.1 },
                        { label: '+1s', delta: 1 },
                      ].map((step) => (
                        <button
                          key={step.label}
                          type="button"
                          onClick={() => {
                            const fromInput = parseOffsetInputToSeconds(routeOffsetValue);
                            const baseOffset = fromInput ?? route.offsetSec;
                            const nextOffset = normalizeOffsetSeconds(baseOffset + step.delta);
                            void handleSetRouteOffset(route.routeId, nextOffset);
                          }}
                        >
                          {step.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          void handleSetRouteOffset(route.routeId, 0);
                        }}
                      >
                        Offset 0
                      </button>
                    </div>
                  </div>

                  <div className="card-actions">
                    <button
                      type="button"
                      disabled={isMainRoute}
                      onClick={() => {
                        void handleSetMainRoute(route.routeId);
                      }}
                    >
                      {isMainRoute ? 'Main Route' : 'Set Main'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleRouteCommand(route.routeId, ROUTE_COMMAND.PLAY).catch((error) => {
                          setStatus(toErrorMessage(error, 'Play failed.'));
                        });
                      }}
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleRouteCommand(route.routeId, ROUTE_COMMAND.PAUSE).catch((error) => {
                          setStatus(toErrorMessage(error, 'Pause failed.'));
                        });
                      }}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleRouteCommand(route.routeId, ROUTE_COMMAND.GET_STATUS).catch((error) => {
                          setStatus(toErrorMessage(error, 'Pull status failed.'));
                        });
                      }}
                    >
                      Pull Status
                    </button>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <footer className="status-bar">
        <span>{statusText}</span>
      </footer>
    </main>
  );
}
