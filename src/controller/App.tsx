import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  FiArrowUpRight,
  FiClock,
  FiDownload,
  FiPause,
  FiPlay,
  FiRefreshCw,
  FiSearch,
  FiSliders,
  FiTrash2,
} from 'react-icons/fi';
import {
  BG_EVENT,
  CONTROLLER_TO_BG,
  ERROR_CODE,
  ROUTE_COMMAND,
  TAB_SCAN_SCOPE,
  type CandidateTab,
  type ControllerResponse,
  type ControllerToBackgroundMessage,
  type ErrorCode,
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

type RouteSyncStatus =
  | 'unknown'
  | 'synced'
  | 'minor-drift'
  | 'soft-correcting'
  | 'hard-correcting'
  | 'severe-drift'
  | 'error';

interface RouteRuntimeState {
  driftSec: number | null;
  syncStatus: RouteSyncStatus;
  lastError: string | null;
}

const AUTO_SYNC_INTERVAL_MS = 500;
const AUTO_SYNC_STABLE_DRIFT_SEC = 0.1;
const AUTO_SYNC_MINOR_DRIFT_SEC = 0.3;
const AUTO_SYNC_HARD_DRIFT_SEC = 1.0;
const AUTO_SYNC_HARD_COOLDOWN_MS = 3000;
const AUTO_SYNC_MAX_RATE_DELTA = 0.02;
const VOLUME_SLIDER_DEBOUNCE_MS = 180;
const BG_RESPONSE_TIMEOUT_MS = 2500;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.values(ERROR_CODE).includes(value as ErrorCode);
}

function isErrorResponse(response: ControllerResponse): response is ErrorResponse {
  return !response.ok;
}

function formatErrorResponse(response: ErrorResponse): string {
  return `[${response.errorCode}] ${response.error}`;
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timerId: number | null = null;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timerId = window.setTimeout(() => {
      reject(new TimeoutError(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (typeof timerId === 'number') {
      window.clearTimeout(timerId);
    }
  }
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
    typeof value.targetVolumePercent === 'number' &&
    typeof value.targetMuted === 'boolean' &&
    typeof value.appliedMuted === 'boolean' &&
    (value.status === 'loading' ||
      value.status === 'playing' ||
      value.status === 'paused' ||
      value.status === 'buffering' ||
      value.status === 'ad' ||
      value.status === 'ended' ||
      value.status === 'error') &&
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
    return (
      typeof value.error === 'string' &&
      isErrorCode(value.errorCode) &&
      typeof value.atMs === 'number' &&
      Number.isFinite(value.atMs)
    );
  }

  return true;
}

function normalizeOffsetSeconds(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeVolumePercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
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

function parseVolumeInputToPercent(rawInput: string): number | null {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return normalizeVolumePercent(parsed);
}

function computeSoftCorrectionPlaybackRate(driftSec: number): number {
  const delta = Math.max(-AUTO_SYNC_MAX_RATE_DELTA, Math.min(AUTO_SYNC_MAX_RATE_DELTA, driftSec * 0.02));
  const nextRate = 1 + delta;
  return Math.max(0.25, Math.min(2, Number(nextRate.toFixed(3))));
}

function formatDrift(driftSec: number | null): string {
  if (driftSec === null || !Number.isFinite(driftSec)) {
    return '--';
  }

  const sign = driftSec > 0 ? '+' : '';
  return `${sign}${driftSec.toFixed(3)}s`;
}

function isRouteCardInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      'button,input,select,textarea,a,label,[contenteditable],[data-prevent-route-focus="true"]',
    ),
  );
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
  const request = new Promise<ControllerResponse>((resolve, reject) => {
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

  return withTimeout(
    request,
    BG_RESPONSE_TIMEOUT_MS,
    `[${ERROR_CODE.TIMEOUT_BG_RESPONSE}] Timed out while waiting for background response.`,
  );
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
  const [selectedCandidateTabIds, setSelectedCandidateTabIds] = useState<Record<number, boolean>>({});
  const [statusText, setStatusText] = useState('Ready.');
  const [scanScope, setScanScope] = useState<TabScanScope>(TAB_SCAN_SCOPE.ALL_WINDOWS);
  const [seekAllInput, setSeekAllInput] = useState('');
  const [routeOffsetDrafts, setRouteOffsetDrafts] = useState<Record<string, string>>({});
  const [editingRouteOffsets, setEditingRouteOffsets] = useState<Record<string, boolean>>({});
  const [routeVolumeDrafts, setRouteVolumeDrafts] = useState<Record<string, string>>({});
  const [editingRouteVolumes, setEditingRouteVolumes] = useState<Record<string, boolean>>({});
  const [autoFocusEnabled, setAutoFocusEnabled] = useState(false);
  const [focusedRouteId, setFocusedRouteId] = useState<string | null>(null);
  const [autoSyncCorrectionEnabled, setAutoSyncCorrectionEnabled] = useState(false);
  const [routeRuntimeById, setRouteRuntimeById] = useState<Record<string, RouteRuntimeState>>({});
  const autoSyncTickRunningRef = useRef(false);
  const lastHardCorrectionAtMsRef = useRef<Record<string, number>>({});
  const lastPlaybackRateByRouteIdRef = useRef<Record<string, number>>({});
  const volumeDebounceTimerByRouteIdRef = useRef<Record<string, number>>({});
  const pendingVolumeByRouteIdRef = useRef<Record<string, number>>({});

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
      throw new Error(formatErrorResponse(response));
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
        throw new Error(formatErrorResponse(response));
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
          throw new Error(formatErrorResponse(response));
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

  const handleToggleCandidateSelection = useCallback((tabId: number, selected: boolean): void => {
    setSelectedCandidateTabIds((prev) => {
      const next = { ...prev };

      if (selected) {
        next[tabId] = true;
      } else {
        delete next[tabId];
      }

      return next;
    });
  }, []);

  const handleSelectAllCandidates = useCallback((): void => {
    setSelectedCandidateTabIds(() => {
      const next: Record<number, boolean> = {};
      viewState.candidates.forEach((candidate) => {
        next[candidate.tabId] = true;
      });
      return next;
    });
  }, [viewState.candidates]);

  const handleClearCandidateSelection = useCallback((): void => {
    setSelectedCandidateTabIds({});
  }, []);

  const handleImportTab = useCallback(
    async (tabId: number): Promise<void> => {
      try {
        setStatus(`Importing tab ${tabId}...`);

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.IMPORT_TAB,
          payload: { tabId },
        });

        if (isErrorResponse(response)) {
          throw new Error(formatErrorResponse(response));
        }

        await refreshSession();
        setSelectedCandidateTabIds((prev) => {
          if (!prev[tabId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[tabId];
          return next;
        });

        const alreadyImported = 'alreadyImported' in response && response.alreadyImported === true;
        setStatus(alreadyImported ? `Tab ${tabId} already imported.` : `Tab ${tabId} imported.`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Import failed.'));
      }
    },
    [refreshSession, setStatus],
  );

  const handleImportSelectedTabs = useCallback(async (): Promise<void> => {
    const selectedTabIds = viewState.candidates
      .map((candidate) => candidate.tabId)
      .filter((tabId) => selectedCandidateTabIds[tabId]);

    if (selectedTabIds.length === 0) {
      setStatus('No selected candidate tabs.');
      return;
    }

    const importedTabIdSet = new Set(viewState.session.routes.map((route) => route.tabId));
    const pendingTabIds = selectedTabIds.filter((tabId) => !importedTabIdSet.has(tabId));

    if (pendingTabIds.length === 0) {
      setStatus('Selected tabs are already imported.');
      return;
    }

    setStatus(`Importing ${pendingTabIds.length} selected tab(s)...`);

    const results = await Promise.allSettled(
      pendingTabIds.map(async (tabId) => {
        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.IMPORT_TAB,
          payload: { tabId },
        });

        if (isErrorResponse(response)) {
          throw new Error(formatErrorResponse(response));
        }

        return {
          tabId,
          alreadyImported: 'alreadyImported' in response && response.alreadyImported === true,
        };
      }),
    );

    await refreshSession();

    const successCount = results.filter((result) => result.status === 'fulfilled').length;
    const failedCount = pendingTabIds.length - successCount;
    const alreadyImportedCount = results.filter(
      (result) => result.status === 'fulfilled' && result.value.alreadyImported,
    ).length;

    setSelectedCandidateTabIds((prev) => {
      const next = { ...prev };
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          delete next[result.value.tabId];
        }
      });
      return next;
    });

    if (failedCount === 0) {
      setStatus(
        alreadyImportedCount === 0
          ? `Imported ${successCount} selected tab(s).`
          : `Imported ${successCount} selected tab(s), ${alreadyImportedCount} already existed.`,
      );
      return;
    }

    setStatus(`Import selected finished: ${successCount} success, ${failedCount} failed.`);
  }, [refreshSession, selectedCandidateTabIds, setStatus, viewState.candidates, viewState.session.routes]);

  const handleRemoveRoute = useCallback(
    async (routeId: string): Promise<void> => {
      try {
        setStatus(`Removing route ${routeId}...`);

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.REMOVE_ROUTE,
          payload: { routeId },
        });

        if (isErrorResponse(response)) {
          throw new Error(formatErrorResponse(response));
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
          throw new Error(formatErrorResponse(response));
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
          throw new Error(formatErrorResponse(response));
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

  const handleSetRouteVolume = useCallback(
    async (
      routeId: string,
      volumePercent: number,
      options: { silent?: boolean } = {},
    ): Promise<void> => {
      try {
        const { silent = false } = options;
        const normalizedVolumePercent = normalizeVolumePercent(volumePercent);

        if (!silent) {
          setStatus(`Updating volume for ${routeId} to ${normalizedVolumePercent}%...`);
        }

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.SET_ROUTE_VOLUME,
          payload: {
            routeId,
            volumePercent: normalizedVolumePercent,
          },
        });

        if (isErrorResponse(response)) {
          throw new Error(formatErrorResponse(response));
        }

        if (!('session' in response) || !isSessionSnapshot(response.session)) {
          throw new Error('Unexpected set-route-volume response shape.');
        }

        setRouteVolumeDrafts((prev) => ({
          ...prev,
          [routeId]: String(normalizedVolumePercent),
        }));

        applySessionSnapshot(response.session);

        if (!silent) {
          setStatus(`Volume updated for ${routeId}: ${normalizedVolumePercent}%.`);
        }
      } catch (error) {
        setStatus(toErrorMessage(error, 'Set route volume failed.'));
      }
    },
    [applySessionSnapshot, setStatus],
  );

  const handleSetRouteMuted = useCallback(
    async (routeId: string, isMuted: boolean): Promise<void> => {
      try {
        setStatus(`${isMuted ? 'Muting' : 'Unmuting'} route ${routeId}...`);

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.SET_ROUTE_MUTED,
          payload: {
            routeId,
            isMuted,
          },
        });

        if (isErrorResponse(response)) {
          throw new Error(formatErrorResponse(response));
        }

        if (!('session' in response) || !isSessionSnapshot(response.session)) {
          throw new Error('Unexpected set-route-muted response shape.');
        }

        applySessionSnapshot(response.session);
        setStatus(`Route ${routeId} ${isMuted ? 'muted' : 'unmuted'} (base setting).`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Set route muted failed.'));
      }
    },
    [applySessionSnapshot, setStatus],
  );

  const handleSetSoloRoute = useCallback(
    async (routeId: string | null): Promise<void> => {
      try {
        setStatus(routeId ? `Setting solo route: ${routeId}...` : 'Clearing solo route...');

        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.SET_SOLO_ROUTE,
          payload: {
            routeId,
          },
        });

        if (isErrorResponse(response)) {
          throw new Error(formatErrorResponse(response));
        }

        if (!('session' in response) || !isSessionSnapshot(response.session)) {
          throw new Error('Unexpected set-solo-route response shape.');
        }

        applySessionSnapshot(response.session);
        setStatus(routeId ? `Solo route set: ${routeId}.` : 'Solo route cleared.');
      } catch (error) {
        setStatus(toErrorMessage(error, 'Set solo route failed.'));
      }
    },
    [applySessionSnapshot, setStatus],
  );

  const handleFocusRouteTab = useCallback(
    async (routeId: string): Promise<void> => {
      setFocusedRouteId(routeId);

      try {
        const response = await sendToBackground({
          type: CONTROLLER_TO_BG.FOCUS_ROUTE_TAB,
          payload: {
            routeId,
          },
        });

        if (isErrorResponse(response)) {
          throw new Error(formatErrorResponse(response));
        }

        if (!('session' in response) || !isSessionSnapshot(response.session)) {
          throw new Error('Unexpected focus-route-tab response shape.');
        }

        applySessionSnapshot(response.session);
        setStatus(`Focused route ${routeId} tab.`);
      } catch (error) {
        setStatus(toErrorMessage(error, 'Focus route tab failed.'));
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
          throw new Error(formatErrorResponse(response));
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

  const runAutoSyncCorrectionTick = useCallback(async (): Promise<void> => {
    if (autoSyncTickRunningRef.current || !autoSyncCorrectionEnabled) {
      return;
    }

    const referenceRoute = resolveReferenceRoute(viewState.session);

    if (!referenceRoute) {
      return;
    }

    autoSyncTickRunningRef.current = true;

    try {
      const routes = viewState.session.routes;

      const routeSnapshots = await Promise.allSettled(
        routes.map(async (route) => {
          const snapshot = await handleRouteCommand(route.routeId, ROUTE_COMMAND.GET_STATUS);
          return {
            routeId: route.routeId,
            snapshot,
          };
        }),
      );

      const snapshotByRouteId = new Map<string, RouteSnapshot>();
      const runtimeNext: Record<string, RouteRuntimeState> = {};

      routeSnapshots.forEach((result, index) => {
        const route = routes[index];

        if (result.status === 'fulfilled' && result.value.snapshot !== null) {
          snapshotByRouteId.set(route.routeId, result.value.snapshot);
          return;
        }

        runtimeNext[route.routeId] = {
          driftSec: null,
          syncStatus: 'error',
          lastError:
            result.status === 'rejected'
              ? toErrorMessage(result.reason, 'Status pull failed.')
              : 'Status snapshot unavailable.',
        };
      });

      const referenceCurrentTimeSec =
        snapshotByRouteId.get(referenceRoute.routeId)?.currentTimeSec ?? referenceRoute.currentTimeSec;

      if (!Number.isFinite(referenceCurrentTimeSec)) {
        return;
      }

      const masterTimeSec = referenceCurrentTimeSec - referenceRoute.offsetSec;
      const nowMs = Date.now();

      for (const route of routes) {
        const snapshot = snapshotByRouteId.get(route.routeId);

        if (!snapshot || !Number.isFinite(snapshot.currentTimeSec)) {
          continue;
        }

        const targetTimeSec = masterTimeSec + route.offsetSec;
        const driftSec = targetTimeSec - snapshot.currentTimeSec;
        const absDriftSec = Math.abs(driftSec);
        const isReferenceRoute = route.routeId === referenceRoute.routeId;

        if (isReferenceRoute) {
          runtimeNext[route.routeId] = {
            driftSec,
            syncStatus: absDriftSec < AUTO_SYNC_STABLE_DRIFT_SEC ? 'synced' : 'minor-drift',
            lastError: null,
          };
          continue;
        }

        const syncState: RouteRuntimeState = {
          driftSec,
          syncStatus: 'synced',
          lastError: null,
        };

        if (absDriftSec < AUTO_SYNC_STABLE_DRIFT_SEC) {
          const previousRate = lastPlaybackRateByRouteIdRef.current[route.routeId] ?? 1;

          if (Math.abs(previousRate - 1) >= 0.005) {
            try {
              await handleRouteCommand(route.routeId, ROUTE_COMMAND.SET_PLAYBACK_RATE, {
                playbackRate: 1,
              });
              lastPlaybackRateByRouteIdRef.current[route.routeId] = 1;
            } catch (error) {
              syncState.syncStatus = 'error';
              syncState.lastError = toErrorMessage(error, 'Failed to reset playbackRate.');
            }
          }

          runtimeNext[route.routeId] = syncState;
          continue;
        }

        if (absDriftSec < AUTO_SYNC_MINOR_DRIFT_SEC) {
          syncState.syncStatus = 'minor-drift';
          runtimeNext[route.routeId] = syncState;
          continue;
        }

        if (absDriftSec >= AUTO_SYNC_HARD_DRIFT_SEC) {
          const lastHardCorrectionAtMs = lastHardCorrectionAtMsRef.current[route.routeId] ?? 0;
          const isHardCorrectionAllowed = nowMs - lastHardCorrectionAtMs >= AUTO_SYNC_HARD_COOLDOWN_MS;

          if (isHardCorrectionAllowed) {
            try {
              await handleRouteCommand(route.routeId, ROUTE_COMMAND.SEEK, {
                timeSec: Math.max(0, targetTimeSec),
              });
              lastHardCorrectionAtMsRef.current[route.routeId] = nowMs;
              syncState.syncStatus = 'hard-correcting';
            } catch (error) {
              syncState.syncStatus = 'error';
              syncState.lastError = toErrorMessage(error, 'Hard correction failed.');
            }

            runtimeNext[route.routeId] = syncState;
            continue;
          }

          syncState.syncStatus = 'severe-drift';
        } else {
          syncState.syncStatus = 'soft-correcting';
        }

        const targetRate = computeSoftCorrectionPlaybackRate(driftSec);

        try {
          await handleRouteCommand(route.routeId, ROUTE_COMMAND.SET_PLAYBACK_RATE, {
            playbackRate: targetRate,
          });
          lastPlaybackRateByRouteIdRef.current[route.routeId] = targetRate;
        } catch (error) {
          syncState.syncStatus = 'error';
          syncState.lastError = toErrorMessage(error, 'Soft correction failed.');
        }

        runtimeNext[route.routeId] = syncState;
      }

      setRouteRuntimeById((prev) => ({
        ...prev,
        ...runtimeNext,
      }));
    } finally {
      autoSyncTickRunningRef.current = false;
    }
  }, [autoSyncCorrectionEnabled, handleRouteCommand, viewState.session]);

  const toggleAutoSyncCorrection = useCallback((): void => {
    const nextEnabled = !autoSyncCorrectionEnabled;
    setAutoSyncCorrectionEnabled(nextEnabled);

    if (nextEnabled) {
      setStatus('Auto Sync Correction started.');
      return;
    }

    setStatus('Auto Sync Correction stopped.');
    autoSyncTickRunningRef.current = false;
    lastHardCorrectionAtMsRef.current = {};
    lastPlaybackRateByRouteIdRef.current = {};

    void Promise.allSettled(
      viewState.session.routes.map((route) =>
        handleRouteCommand(route.routeId, ROUTE_COMMAND.SET_PLAYBACK_RATE, { playbackRate: 1 }),
      ),
    ).then(() => {
      void refreshSession().catch(() => {
        // Ignore refresh failure when stopping correction.
      });
    });
  }, [autoSyncCorrectionEnabled, handleRouteCommand, refreshSession, setStatus, viewState.session.routes]);

  const toggleAutoFocus = useCallback((): void => {
    const nextEnabled = !autoFocusEnabled;
    setAutoFocusEnabled(nextEnabled);

    if (!nextEnabled) {
      setFocusedRouteId(null);
    }

    setStatus(nextEnabled ? 'Auto Focus enabled.' : 'Auto Focus disabled.');
  }, [autoFocusEnabled, setStatus]);

  const scheduleRouteVolumeCommit = useCallback(
    (routeId: string, volumePercent: number): void => {
      const normalizedVolumePercent = normalizeVolumePercent(volumePercent);
      pendingVolumeByRouteIdRef.current[routeId] = normalizedVolumePercent;

      const existingTimerId = volumeDebounceTimerByRouteIdRef.current[routeId];
      if (typeof existingTimerId === 'number') {
        window.clearTimeout(existingTimerId);
      }

      volumeDebounceTimerByRouteIdRef.current[routeId] = window.setTimeout(() => {
        delete volumeDebounceTimerByRouteIdRef.current[routeId];

        const pendingVolumePercent = pendingVolumeByRouteIdRef.current[routeId];
        if (typeof pendingVolumePercent !== 'number') {
          return;
        }

        delete pendingVolumeByRouteIdRef.current[routeId];
        void handleSetRouteVolume(routeId, pendingVolumePercent, { silent: true });
      }, VOLUME_SLIDER_DEBOUNCE_MS);
    },
    [handleSetRouteVolume],
  );

  const flushRouteVolumeCommit = useCallback(
    (routeId: string, draftValue: string): void => {
      const existingTimerId = volumeDebounceTimerByRouteIdRef.current[routeId];
      if (typeof existingTimerId === 'number') {
        window.clearTimeout(existingTimerId);
        delete volumeDebounceTimerByRouteIdRef.current[routeId];
      }

      const pendingVolumePercent = pendingVolumeByRouteIdRef.current[routeId];
      if (typeof pendingVolumePercent === 'number') {
        delete pendingVolumeByRouteIdRef.current[routeId];
        void handleSetRouteVolume(routeId, pendingVolumePercent, { silent: true });
        return;
      }

      const parsedVolumePercent = parseVolumeInputToPercent(draftValue);
      if (parsedVolumePercent === null) {
        return;
      }

      void handleSetRouteVolume(routeId, parsedVolumePercent, { silent: true });
    },
    [handleSetRouteVolume],
  );

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
    setRouteVolumeDrafts((prev) => {
      const next: Record<string, string> = {};

      viewState.session.routes.forEach((route) => {
        const key = route.routeId;
        const routeCanonical = String(normalizeVolumePercent(route.targetVolumePercent));
        next[key] = editingRouteVolumes[key] ? (prev[key] ?? routeCanonical) : routeCanonical;
      });

      return next;
    });
  }, [editingRouteVolumes, viewState.session.routes]);

  useEffect(() => {
    setSelectedCandidateTabIds((prev) => {
      const next: Record<number, boolean> = {};

      viewState.candidates.forEach((tab) => {
        if (prev[tab.tabId]) {
          next[tab.tabId] = true;
        }
      });

      return next;
    });
  }, [viewState.candidates]);

  useEffect(
    () => () => {
      const timerIds = Object.values(volumeDebounceTimerByRouteIdRef.current);
      timerIds.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      volumeDebounceTimerByRouteIdRef.current = {};
      pendingVolumeByRouteIdRef.current = {};
    },
    [],
  );

  useEffect(() => {
    if (!focusedRouteId) {
      return;
    }

    const exists = viewState.session.routes.some((route) => route.routeId === focusedRouteId);
    if (!exists) {
      setFocusedRouteId(null);
    }
  }, [focusedRouteId, viewState.session.routes]);

  useEffect(() => {
    setRouteRuntimeById((prev) => {
      const next: Record<string, RouteRuntimeState> = {};

      viewState.session.routes.forEach((route) => {
        next[route.routeId] =
          prev[route.routeId] ??
          ({
            driftSec: null,
            syncStatus: 'unknown',
            lastError: null,
          } satisfies RouteRuntimeState);
      });

      return next;
    });

    const activeRouteIds = new Set(viewState.session.routes.map((route) => route.routeId));
    Object.keys(lastHardCorrectionAtMsRef.current).forEach((routeId) => {
      if (!activeRouteIds.has(routeId)) {
        delete lastHardCorrectionAtMsRef.current[routeId];
      }
    });
    Object.keys(lastPlaybackRateByRouteIdRef.current).forEach((routeId) => {
      if (!activeRouteIds.has(routeId)) {
        delete lastPlaybackRateByRouteIdRef.current[routeId];
      }
    });

    Object.keys(volumeDebounceTimerByRouteIdRef.current).forEach((routeId) => {
      if (!activeRouteIds.has(routeId)) {
        const timerId = volumeDebounceTimerByRouteIdRef.current[routeId];
        if (typeof timerId === 'number') {
          window.clearTimeout(timerId);
        }
        delete volumeDebounceTimerByRouteIdRef.current[routeId];
      }
    });

    Object.keys(pendingVolumeByRouteIdRef.current).forEach((routeId) => {
      if (!activeRouteIds.has(routeId)) {
        delete pendingVolumeByRouteIdRef.current[routeId];
      }
    });
  }, [viewState.session.routes]);

  useEffect(() => {
    if (!autoSyncCorrectionEnabled) {
      return;
    }

    void runAutoSyncCorrectionTick();

    const timer = window.setInterval(() => {
      void runAutoSyncCorrectionTick();
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [autoSyncCorrectionEnabled, runAutoSyncCorrectionTick]);

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
          throw new Error(formatErrorResponse(hello));
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

  const selectedCandidateCount = useMemo(
    () =>
      viewState.candidates.filter((candidate) => selectedCandidateTabIds[candidate.tabId]).length,
    [selectedCandidateTabIds, viewState.candidates],
  );

  const allCandidatesSelected =
    viewState.candidates.length > 0 && selectedCandidateCount === viewState.candidates.length;

  return (
    <Stack gap="md" className="app">
      <Paper withBorder radius="lg" p="md" className="panel">
        <Group justify="space-between" align="flex-start">
          <Box>
            <Group gap="xs" align="center">
              <Title order={3}>Archive Sync Controller</Title>
              <Badge variant="light" color="blue">
                TabSync Mode
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Compact multi-tab control console
            </Text>
          </Box>
          <Group gap="md">
            <Switch
              checked={autoFocusEnabled}
              onChange={toggleAutoFocus}
              label="Auto Focus"
              size="sm"
            />
            <Switch
              checked={autoSyncCorrectionEnabled}
              onChange={toggleAutoSyncCorrection}
              label="Auto Sync Correction"
              size="sm"
            />
          </Group>
        </Group>
      </Paper>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Paper withBorder radius="lg" p="md" className="panel">
          <Stack gap="sm">
            <Group justify="space-between" align="center">
              <Group gap={6} align="center">
                <FiSearch />
                <Title order={5}>Tab Scan</Title>
              </Group>
              <Badge variant="light" color="gray">
                {`selected:${selectedCandidateCount}/${viewState.candidates.length}`}
              </Badge>
            </Group>

            <Group gap="xs" wrap="wrap" align="end">
              <NativeSelect
                label="Scope"
                value={scanScope}
                onChange={(event) => setScanScope(event.currentTarget.value as TabScanScope)}
                data={[
                  { value: TAB_SCAN_SCOPE.ALL_WINDOWS, label: 'All Windows' },
                  { value: TAB_SCAN_SCOPE.CURRENT_WINDOW, label: 'Current Window' },
                ]}
              />
              <Button
                leftSection={<FiSearch size={14} />}
                onClick={() => void handleScanTabs(scanScope)}
              >
                Scan
              </Button>
              <Button
                variant="default"
                disabled={viewState.candidates.length === 0 || allCandidatesSelected}
                onClick={handleSelectAllCandidates}
              >
                Select All
              </Button>
              <Button
                variant="default"
                disabled={selectedCandidateCount === 0}
                onClick={handleClearCandidateSelection}
              >
                Clear
              </Button>
              <Button
                leftSection={<FiDownload size={14} />}
                disabled={selectedCandidateCount === 0}
                onClick={() => {
                  void handleImportSelectedTabs().catch((error) => {
                    setStatus(toErrorMessage(error, 'Import selected failed.'));
                  });
                }}
              >
                Import Selected
              </Button>
            </Group>

            <Stack gap="xs">
              {viewState.candidates.length === 0 ? (
                <Text c="dimmed" fs="italic">
                  No candidate tabs.
                </Text>
              ) : (
                viewState.candidates.map((tab) => {
                  const isImported = importedTabIds.has(tab.tabId);
                  const isSelected = Boolean(selectedCandidateTabIds[tab.tabId]);

                  return (
                    <Paper key={tab.tabId} withBorder radius="md" p="sm" className="card candidate-card">
                      <Group justify="space-between" align="flex-start" wrap="nowrap">
                        <Checkbox
                          checked={isSelected}
                          onChange={(event) => {
                            handleToggleCandidateSelection(tab.tabId, event.currentTarget.checked);
                          }}
                          label={tab.title || '(Untitled tab)'}
                          className="candidate-title"
                        />
                        <Button
                          size="xs"
                          variant={isImported ? 'light' : 'filled'}
                          disabled={isImported}
                          onClick={() => {
                            void handleImportTab(tab.tabId);
                          }}
                        >
                          {isImported ? 'Imported' : 'Import'}
                        </Button>
                      </Group>
                      <Text className="meta">{`tab:${tab.tabId} | window:${tab.windowId} | ${tab.url}`}</Text>
                    </Paper>
                  );
                })
              )}
            </Stack>
          </Stack>
        </Paper>

        <Paper withBorder radius="lg" p="md" className="panel">
          <Stack gap="sm">
            <Group gap={6} align="center">
              <FiSliders />
              <Title order={5}>Global Controls</Title>
            </Group>
            <Group gap="xs" wrap="wrap">
              <Button
                variant="default"
                leftSection={<FiRefreshCw size={14} />}
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
              </Button>
              <Button
                leftSection={<FiPlay size={14} />}
                onClick={() => {
                  void runAllRoutesCommand(ROUTE_COMMAND.PLAY).catch((error) => {
                    setStatus(toErrorMessage(error, 'Play all failed.'));
                  });
                }}
              >
                Play All
              </Button>
              <Button
                color="gray"
                leftSection={<FiPause size={14} />}
                onClick={() => {
                  void runAllRoutesCommand(ROUTE_COMMAND.PAUSE).catch((error) => {
                    setStatus(toErrorMessage(error, 'Pause all failed.'));
                  });
                }}
              >
                Pause All
              </Button>
              <TextInput
                placeholder="Seek target: ss / mm:ss / hh:mm:ss"
                value={seekAllInput}
                onChange={(event) => setSeekAllInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runSeekAll().catch((error) => {
                      setStatus(toErrorMessage(error, 'Seek all failed.'));
                    });
                  }
                }}
              />
              <Button
                leftSection={<FiClock size={14} />}
                onClick={() => {
                  void runSeekAll().catch((error) => {
                    setStatus(toErrorMessage(error, 'Seek all failed.'));
                  });
                }}
              >
                Seek All
              </Button>
              <Button
                variant="default"
                leftSection={<FiArrowUpRight size={14} />}
                onClick={() => {
                  void runSyncNow().catch((error) => {
                    setStatus(toErrorMessage(error, 'Sync now failed.'));
                  });
                }}
              >
                Sync Now
              </Button>
              <Button
                variant="default"
                leftSection={<FiDownload size={14} />}
                onClick={() => {
                  void runReadOffsets().catch((error) => {
                    setStatus(toErrorMessage(error, 'Read offsets failed.'));
                  });
                }}
              >
                Read Offsets
              </Button>
            </Group>
          </Stack>
        </Paper>
      </SimpleGrid>

      <Paper withBorder radius="lg" p="md" className="panel">
        <Stack gap="sm">
          <Group justify="space-between" align="center">
            <Title order={5}>Session Routes</Title>
            <Badge variant="light" color="gray">{`${viewState.session.routes.length} route(s)`}</Badge>
          </Group>

          <Stack gap="xs">
            {viewState.session.routes.length === 0 ? (
              <Text c="dimmed" fs="italic">
                No imported routes.
              </Text>
            ) : (
              viewState.session.routes.map((route) => {
                const isMainRoute = route.routeId === viewState.session.mainRouteId;
                const isSoloRoute = route.routeId === viewState.session.soloRouteId;
                const isFocusedRoute = route.routeId === focusedRouteId;
                const isForcedMutedBySolo =
                  typeof viewState.session.soloRouteId === 'string' &&
                  viewState.session.soloRouteId !== route.routeId;
                const routeOffsetValue =
                  routeOffsetDrafts[route.routeId] ?? normalizeOffsetSeconds(route.offsetSec).toFixed(2);
                const routeVolumeValue =
                  routeVolumeDrafts[route.routeId] ?? String(normalizeVolumePercent(route.targetVolumePercent));
                const routeVolumePercent =
                  parseVolumeInputToPercent(routeVolumeValue) ?? normalizeVolumePercent(route.targetVolumePercent);
                const runtimeState = routeRuntimeById[route.routeId];

                return (
                  <Paper
                    key={route.routeId}
                    withBorder
                    radius="md"
                    p="sm"
                    className={`card${isMainRoute ? ' main-route' : ''}${isFocusedRoute ? ' focused-route' : ''}`}
                    onClick={(event) => {
                      if (!autoFocusEnabled) {
                        return;
                      }

                      if (isRouteCardInteractiveTarget(event.target)) {
                        return;
                      }

                      void handleFocusRouteTab(route.routeId);
                    }}
                  >
                    <Group justify="space-between" align="flex-start" wrap="nowrap" className="card-head">
                      <Group gap="xs" align="center">
                        <Text fw={600} className="title">
                          {route.videoTitle || route.tabTitle || '(Unknown title)'}
                        </Text>
                        {isMainRoute ? (
                          <Badge size="xs" color="green" variant="light">
                            MAIN
                          </Badge>
                        ) : null}
                        {isSoloRoute ? (
                          <Badge size="xs" color="yellow" variant="light">
                            SOLO
                          </Badge>
                        ) : null}
                      </Group>
                      <Button
                        type="button"
                        size="xs"
                        color="red"
                        variant="light"
                        leftSection={<FiTrash2 size={13} />}
                        onClick={() => {
                          void handleRemoveRoute(route.routeId);
                        }}
                      >
                        Remove
                      </Button>
                    </Group>

                    <Text className="meta">
                      {[
                        `route:${route.routeId}`,
                        `tab:${route.tabId}`,
                        `status:${route.status}`,
                        `time:${formatTime(route.currentTimeSec)}`,
                        `offset:${normalizeOffsetSeconds(route.offsetSec).toFixed(2)}s`,
                        `vol:${normalizeVolumePercent(route.targetVolumePercent)}%`,
                        `baseMute:${route.targetMuted ? 'on' : 'off'}`,
                        `appliedMute:${route.appliedMuted ? 'on' : 'off'}`,
                        `drift:${formatDrift(runtimeState?.driftSec ?? null)}`,
                        `sync:${runtimeState?.syncStatus ?? 'unknown'}`,
                      ].join(' | ')}
                    </Text>

                    {runtimeState?.lastError ? (
                      <Text className="meta error-meta">{`sync-error:${runtimeState.lastError}`}</Text>
                    ) : null}

                    <Group gap="xs" wrap="wrap" className="offset-controls">
                      <TextInput
                        className="offset-input"
                        inputMode="decimal"
                        placeholder="offset sec"
                        title="Supports signed seconds or signed mm:ss / hh:mm:ss"
                        value={routeOffsetValue}
                        onChange={(event) => {
                          const nextValue = event.currentTarget.value;
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
                          setEditingRouteOffsets((prev) => ({
                            ...prev,
                            [route.routeId]: false,
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
                      <Button
                        size="xs"
                        onMouseDown={(event) => {
                          // Keep the input focused until click, so blur side effects do not race submission.
                          event.preventDefault();
                        }}
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
                      </Button>

                      <Group gap="xs" wrap="wrap" className="offset-step-actions">
                        {[
                          { label: '-1s', delta: -1 },
                          { label: '-0.1s', delta: -0.1 },
                          { label: '+0.1s', delta: 0.1 },
                          { label: '+1s', delta: 1 },
                        ].map((step) => (
                          <Button
                            key={step.label}
                            size="xs"
                            variant="default"
                            onClick={() => {
                              const fromInput = parseOffsetInputToSeconds(routeOffsetValue);
                              const baseOffset = fromInput ?? route.offsetSec;
                              const nextOffset = normalizeOffsetSeconds(baseOffset + step.delta);
                              void handleSetRouteOffset(route.routeId, nextOffset);
                            }}
                          >
                            {step.label}
                          </Button>
                        ))}
                        <Button
                          size="xs"
                          variant="default"
                          onClick={() => {
                            void handleSetRouteOffset(route.routeId, 0);
                          }}
                        >
                          Offset 0
                        </Button>
                      </Group>
                    </Group>

                    <Group gap="xs" wrap="wrap" align="center" className="audio-controls">
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => {
                          void handleSetRouteMuted(route.routeId, !route.targetMuted);
                        }}
                      >
                        {route.targetMuted ? 'Base Unmute' : 'Base Mute'}
                      </Button>

                      <Box data-prevent-route-focus="true" className="volume-slider-group">
                        <Slider
                          className="volume-slider"
                          min={0}
                          max={100}
                          step={1}
                          value={routeVolumePercent}
                          onChange={(nextValue) => {
                            const parsedVolumePercent = parseVolumeInputToPercent(String(nextValue));
                            if (parsedVolumePercent === null) {
                              return;
                            }

                            setRouteVolumeDrafts((prev) => ({
                              ...prev,
                              [route.routeId]: String(parsedVolumePercent),
                            }));
                            setEditingRouteVolumes((prev) => ({
                              ...prev,
                              [route.routeId]: true,
                            }));
                            scheduleRouteVolumeCommit(route.routeId, parsedVolumePercent);
                          }}
                          onChangeEnd={(nextValue) => {
                            setEditingRouteVolumes((prev) => ({
                              ...prev,
                              [route.routeId]: false,
                            }));
                            flushRouteVolumeCommit(route.routeId, String(nextValue));
                          }}
                        />
                        <Text className="volume-value">{`${routeVolumePercent}%`}</Text>
                      </Box>

                      <Button
                        size="xs"
                        variant={isSoloRoute ? 'filled' : 'default'}
                        onClick={() => {
                          void handleSetSoloRoute(isSoloRoute ? null : route.routeId);
                        }}
                      >
                        {isSoloRoute ? 'Unsolo' : 'Solo'}
                      </Button>

                      <Text className="audio-meta">
                        {isForcedMutedBySolo ? 'Muted by solo' : route.appliedMuted ? 'Muted' : 'Audible'}
                      </Text>
                    </Group>

                    <Group gap="xs" wrap="wrap" className="card-actions">
                      <Button
                        type="button"
                        size="xs"
                        variant={isMainRoute ? 'light' : 'default'}
                        disabled={isMainRoute}
                        onClick={() => {
                          void handleSetMainRoute(route.routeId);
                        }}
                      >
                        {isMainRoute ? 'Main Route' : 'Set Main'}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        leftSection={<FiPlay size={13} />}
                        onClick={() => {
                          void handleRouteCommand(route.routeId, ROUTE_COMMAND.PLAY).catch((error) => {
                            setStatus(toErrorMessage(error, 'Play failed.'));
                          });
                        }}
                      >
                        Play
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        color="gray"
                        leftSection={<FiPause size={13} />}
                        onClick={() => {
                          void handleRouteCommand(route.routeId, ROUTE_COMMAND.PAUSE).catch((error) => {
                            setStatus(toErrorMessage(error, 'Pause failed.'));
                          });
                        }}
                      >
                        Pause
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="default"
                        leftSection={<FiRefreshCw size={13} />}
                        onClick={() => {
                          void handleRouteCommand(route.routeId, ROUTE_COMMAND.GET_STATUS).catch((error) => {
                            setStatus(toErrorMessage(error, 'Pull status failed.'));
                          });
                        }}
                      >
                        Pull Status
                      </Button>
                    </Group>
                  </Paper>
                );
              })
            )}
          </Stack>
        </Stack>
      </Paper>

      <Paper withBorder radius="md" px="sm" py={8} className="status-bar">
        <Text size="xs" c="dimmed">
          {statusText}
        </Text>
      </Paper>
    </Stack>
  );
}
