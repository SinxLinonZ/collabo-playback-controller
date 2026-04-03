import {
  BG_EVENT,
  BG_TO_CONTENT,
  CONTENT_TO_BG,
  CONTROLLER_TO_BG,
  ROUTE_COMMAND,
  TAB_SCAN_SCOPE,
  WATCH_URL_PATTERNS,
  type BackgroundEventMessage,
  type BackgroundToContentMessage,
  type CandidateTab,
  type ContentCommandResponse,
  type ContentPlayerEventMessage,
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

const ROUTE_COMMAND_VALUES = Object.values(ROUTE_COMMAND) as RouteCommand[];
const TAB_SCAN_SCOPE_VALUES = Object.values(TAB_SCAN_SCOPE) as TabScanScope[];
const CONTROLLER_WINDOW_WIDTH = 480;
const CONTROLLER_WINDOW_HEIGHT = 760;
const CONTENT_PING_MAX_RETRY = 8;
const CONTENT_PING_RETRY_INTERVAL_MS = 120;

const routesById = new Map<string, RouteState>();
const routeIdByTabId = new Map<number, string>();
let controllerWindowId: number | null = null;
let sourceWindowId: number | null = null;

const sessionState: Pick<SessionSnapshot, 'mainRouteId' | 'soloRouteId'> = {
  mainRouteId: null,
  soloRouteId: null,
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isTabScanScope(value: unknown): value is TabScanScope {
  return typeof value === 'string' && TAB_SCAN_SCOPE_VALUES.includes(value as TabScanScope);
}

function isRouteCommand(value: unknown): value is RouteCommand {
  return typeof value === 'string' && ROUTE_COMMAND_VALUES.includes(value as RouteCommand);
}

function isRouteSnapshot(value: unknown): value is RouteSnapshot {
  if (!isObjectRecord(value)) {
    return false;
  }

  const duration = value.durationSec;

  return (
    (value.status === 'loading' ||
      value.status === 'playing' ||
      value.status === 'paused' ||
      value.status === 'buffering') &&
    typeof value.currentTimeSec === 'number' &&
    (duration === null || typeof duration === 'number') &&
    typeof value.playbackRate === 'number' &&
    typeof value.volumePercent === 'number' &&
    typeof value.isMuted === 'boolean' &&
    typeof value.title === 'string' &&
    typeof value.href === 'string'
  );
}

function parseContentCommandResponse(value: unknown): ContentCommandResponse | null {
  if (!isObjectRecord(value) || typeof value.ok !== 'boolean') {
    return null;
  }

  if (value.ok) {
    if (!isRouteSnapshot(value.snapshot)) {
      return null;
    }

    return {
      ok: true,
      snapshot: value.snapshot,
    };
  }

  if (typeof value.error !== 'string') {
    return null;
  }

  return {
    ok: false,
    error: value.error,
  };
}

function parseControllerMessage(value: unknown): ControllerToBackgroundMessage | null {
  if (!isObjectRecord(value) || typeof value.type !== 'string') {
    return null;
  }

  switch (value.type) {
    case CONTROLLER_TO_BG.HELLO:
      return { type: CONTROLLER_TO_BG.HELLO };

    case CONTROLLER_TO_BG.GET_SESSION:
      return { type: CONTROLLER_TO_BG.GET_SESSION };

    case CONTROLLER_TO_BG.LIST_YOUTUBE_TABS: {
      const payload = isObjectRecord(value.payload) ? value.payload : null;
      const scope = isTabScanScope(payload?.scope) ? payload.scope : TAB_SCAN_SCOPE.ALL_WINDOWS;

      return {
        type: CONTROLLER_TO_BG.LIST_YOUTUBE_TABS,
        payload: {
          scope,
        },
      };
    }

    case CONTROLLER_TO_BG.IMPORT_TAB: {
      if (!isObjectRecord(value.payload)) {
        return null;
      }

      const tabId = value.payload.tabId;

      if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.IMPORT_TAB,
        payload: {
          tabId,
        },
      };
    }

    case CONTROLLER_TO_BG.REMOVE_ROUTE: {
      if (!isObjectRecord(value.payload) || typeof value.payload.routeId !== 'string' || !value.payload.routeId) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.REMOVE_ROUTE,
        payload: {
          routeId: value.payload.routeId,
        },
      };
    }

    case CONTROLLER_TO_BG.SET_MAIN_ROUTE: {
      if (!isObjectRecord(value.payload) || typeof value.payload.routeId !== 'string' || !value.payload.routeId) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.SET_MAIN_ROUTE,
        payload: {
          routeId: value.payload.routeId,
        },
      };
    }

    case CONTROLLER_TO_BG.SET_ROUTE_OFFSET: {
      if (!isObjectRecord(value.payload)) {
        return null;
      }

      const { routeId, offsetSec } = value.payload;

      if (typeof routeId !== 'string' || !routeId || typeof offsetSec !== 'number' || !Number.isFinite(offsetSec)) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.SET_ROUTE_OFFSET,
        payload: {
          routeId,
          offsetSec,
        },
      };
    }

    case CONTROLLER_TO_BG.SET_ROUTE_VOLUME: {
      if (!isObjectRecord(value.payload)) {
        return null;
      }

      const { routeId, volumePercent } = value.payload;

      if (
        typeof routeId !== 'string' ||
        !routeId ||
        typeof volumePercent !== 'number' ||
        !Number.isFinite(volumePercent)
      ) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.SET_ROUTE_VOLUME,
        payload: {
          routeId,
          volumePercent,
        },
      };
    }

    case CONTROLLER_TO_BG.SET_ROUTE_MUTED: {
      if (!isObjectRecord(value.payload)) {
        return null;
      }

      const { routeId, isMuted } = value.payload;

      if (typeof routeId !== 'string' || !routeId || typeof isMuted !== 'boolean') {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.SET_ROUTE_MUTED,
        payload: {
          routeId,
          isMuted,
        },
      };
    }

    case CONTROLLER_TO_BG.SET_SOLO_ROUTE: {
      if (!isObjectRecord(value.payload)) {
        return null;
      }

      const { routeId } = value.payload;

      if (routeId !== null && (typeof routeId !== 'string' || !routeId)) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.SET_SOLO_ROUTE,
        payload: {
          routeId,
        },
      };
    }

    case CONTROLLER_TO_BG.FOCUS_ROUTE_TAB: {
      if (!isObjectRecord(value.payload)) {
        return null;
      }

      const { routeId } = value.payload;

      if (typeof routeId !== 'string' || !routeId) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.FOCUS_ROUTE_TAB,
        payload: {
          routeId,
        },
      };
    }

    case CONTROLLER_TO_BG.ROUTE_COMMAND: {
      if (!isObjectRecord(value.payload)) {
        return null;
      }

      const { routeId, command } = value.payload;
      const args = isObjectRecord(value.payload.args) ? value.payload.args : {};

      if (typeof routeId !== 'string' || !routeId || !isRouteCommand(command)) {
        return null;
      }

      return {
        type: CONTROLLER_TO_BG.ROUTE_COMMAND,
        payload: {
          routeId,
          command,
          args,
        },
      };
    }

    default:
      return null;
  }
}

function parseContentPlayerEventMessage(value: unknown): ContentPlayerEventMessage | null {
  if (!isObjectRecord(value) || value.type !== CONTENT_TO_BG.PLAYER_EVENT) {
    return null;
  }

  if (!isObjectRecord(value.payload)) {
    return null;
  }

  const { reason, snapshot } = value.payload;

  if (typeof reason !== 'string' || !isRouteSnapshot(snapshot)) {
    return null;
  }

  return {
    type: CONTENT_TO_BG.PLAYER_EVENT,
    payload: {
      reason,
      snapshot,
    },
  };
}

function createRouteId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `route-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

function isYouTubeWatchUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || !url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.youtube.com' && parsed.pathname === '/watch';
  } catch {
    return false;
  }
}

function mapTabToCandidate(tab: chrome.tabs.Tab): CandidateTab | null {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
    return null;
  }

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: Boolean(tab.active),
  };
}

function getControllerPagePath(): string {
  const manifest = chrome.runtime.getManifest();

  if (typeof manifest.options_page === 'string' && manifest.options_page) {
    return manifest.options_page;
  }

  // Fallback path for local debugging if manifest key is missing.
  return 'src/controller/index.html';
}

function getControllerPageUrl(): string {
  return chrome.runtime.getURL(getControllerPagePath());
}

function getExtensionBaseUrl(): string {
  return chrome.runtime.getURL('');
}

function isExtensionInternalUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || !url) {
    return false;
  }

  return url.startsWith(getExtensionBaseUrl());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isReceivingEndMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('Receiving end does not exist');
}

async function resolveControllerWindowId(): Promise<number | null> {
  if (typeof controllerWindowId === 'number') {
    try {
      await chrome.windows.get(controllerWindowId);
      return controllerWindowId;
    } catch {
      controllerWindowId = null;
    }
  }

  const controllerPageUrl = getControllerPageUrl();
  const controllerTabs = await chrome.tabs.query({ url: [controllerPageUrl] });
  const existing = controllerTabs.find((tab) => typeof tab.id === 'number' && typeof tab.windowId === 'number');

  if (!existing || typeof existing.windowId !== 'number') {
    return null;
  }

  controllerWindowId = existing.windowId;
  return controllerWindowId;
}

async function openOrFocusControllerWindow(): Promise<void> {
  const existingWindowId = await resolveControllerWindowId();

  if (typeof existingWindowId === 'number') {
    await chrome.windows.update(existingWindowId, {
      focused: true,
      state: 'normal',
    });

    const controllerPageUrl = getControllerPageUrl();
    const controllerTabs = await chrome.tabs.query({
      windowId: existingWindowId,
      url: [controllerPageUrl],
    });
    const firstControllerTabId = controllerTabs[0]?.id;

    if (typeof firstControllerTabId === 'number') {
      await chrome.tabs.update(firstControllerTabId, { active: true });
    }

    return;
  }

  const createdWindow = await chrome.windows.create({
    url: getControllerPageUrl(),
    type: 'popup',
    focused: true,
    width: CONTROLLER_WINDOW_WIDTH,
    height: CONTROLLER_WINDOW_HEIGHT,
  });

  controllerWindowId = typeof createdWindow.id === 'number' ? createdWindow.id : null;
}

function cloneRoute(route: RouteState): RouteState {
  return {
    ...route,
    lastSnapshot: route.lastSnapshot ? { ...route.lastSnapshot } : null,
  };
}

function buildSessionSnapshot(): SessionSnapshot {
  return {
    mainRouteId: sessionState.mainRouteId,
    soloRouteId: sessionState.soloRouteId,
    routes: Array.from(routesById.values()).map(cloneRoute),
  };
}

function normalizeOffsetSeconds(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeVolumePercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resolveAppliedMuted(routeId: string, targetMuted: boolean): boolean {
  const soloRouteId = sessionState.soloRouteId;

  if (typeof soloRouteId === 'string' && soloRouteId && soloRouteId !== routeId) {
    return true;
  }

  return targetMuted;
}

function emitRuntimeMessage(message: BackgroundEventMessage): void {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}

function emitSessionUpdated(reason: string): void {
  emitRuntimeMessage({
    type: BG_EVENT.SESSION_UPDATED,
    payload: {
      reason,
      session: buildSessionSnapshot(),
    },
  });
}

function ensureSessionRouteRefs(): void {
  if (sessionState.mainRouteId && !routesById.has(sessionState.mainRouteId)) {
    sessionState.mainRouteId = null;
  }

  if (sessionState.soloRouteId && !routesById.has(sessionState.soloRouteId)) {
    sessionState.soloRouteId = null;
  }

  if (!sessionState.mainRouteId) {
    sessionState.mainRouteId = Array.from(routesById.keys())[0] ?? null;
  }
}

async function applyEffectiveMutedState(route: RouteState): Promise<ControllerResponse | null> {
  const previousAppliedMuted = route.appliedMuted;
  const nextAppliedMuted = resolveAppliedMuted(route.routeId, route.targetMuted);

  route.appliedMuted = nextAppliedMuted;

  const response = await executeRouteCommand(route.routeId, ROUTE_COMMAND.SET_MUTED, {
    isMuted: nextAppliedMuted,
  });

  if (!response.ok) {
    route.appliedMuted = previousAppliedMuted;
    route.updatedAtMs = Date.now();
    return response;
  }

  return null;
}

async function listYouTubeTabs(scope: TabScanScope): Promise<CandidateTab[]> {
  const query: chrome.tabs.QueryInfo = {
    url: [...WATCH_URL_PATTERNS],
  };

  if (scope === TAB_SCAN_SCOPE.CURRENT_WINDOW) {
    if (typeof sourceWindowId === 'number') {
      try {
        await chrome.windows.get(sourceWindowId);
        query.windowId = sourceWindowId;
      } catch {
        sourceWindowId = null;
      }
    }

    // If source window is unknown, fall back to all windows instead of controller window.
    if (typeof query.windowId !== 'number') {
      delete query.currentWindow;
    }
  }

  const tabs = await chrome.tabs.query(query);

  return tabs
    .filter((tab) => isYouTubeWatchUrl(tab.url))
    .map(mapTabToCandidate)
    .filter((tab): tab is CandidateTab => tab !== null);
}

function asErrorResponse(error: string): ErrorResponse {
  return { ok: false, error };
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  const pingMessage: BackgroundToContentMessage = {
    type: BG_TO_CONTENT.PING,
  };

  try {
    const existing = parseContentCommandResponse(await chrome.tabs.sendMessage(tabId, pingMessage));
    if (existing && existing.ok) {
      return;
    }
  } catch (error) {
    if (!isReceivingEndMissingError(error)) {
      throw error;
    }
  }

  const contentScriptPath = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];

  if (typeof contentScriptPath !== 'string' || !contentScriptPath) {
    throw new Error('Content script path is missing from manifest.');
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [contentScriptPath],
  });

  for (let attempt = 0; attempt < CONTENT_PING_MAX_RETRY; attempt += 1) {
    try {
      const response = parseContentCommandResponse(await chrome.tabs.sendMessage(tabId, pingMessage));

      if (response && response.ok) {
        return;
      }
    } catch (error) {
      if (!isReceivingEndMissingError(error)) {
        throw error;
      }
    }

    await sleep(CONTENT_PING_RETRY_INTERVAL_MS);
  }

  throw new Error('Content script injection completed but ping timed out.');
}

function findRouteByTabId(tabId: number): RouteState | null {
  const routeId = routeIdByTabId.get(tabId);
  if (!routeId) {
    return null;
  }

  return routesById.get(routeId) ?? null;
}

function updateRouteSnapshot(route: RouteState, snapshot: RouteSnapshot): void {
  const hadSnapshot = route.lastSnapshot !== null;

  route.lastSnapshot = {
    ...snapshot,
    observedAtMs: Date.now(),
  };

  route.status = snapshot.status;
  route.currentTimeSec = Number.isFinite(snapshot.currentTimeSec) ? snapshot.currentTimeSec : route.currentTimeSec;
  route.durationSec = Number.isFinite(snapshot.durationSec) ? snapshot.durationSec : route.durationSec;
  route.videoTitle = snapshot.title || route.videoTitle;
  route.lastError = null;

  if (!hadSnapshot) {
    route.targetVolumePercent = normalizeVolumePercent(snapshot.volumePercent);
    route.targetMuted = Boolean(snapshot.isMuted);
    route.appliedMuted = route.targetMuted;
  }
}

async function importTab(tabId: number): Promise<ControllerResponse> {
  const existingRoute = findRouteByTabId(tabId);
  if (existingRoute) {
    return {
      ok: true,
      alreadyImported: true,
      route: cloneRoute(existingRoute),
    };
  }

  const tab = await chrome.tabs.get(tabId);

  if (!tab || typeof tab.id !== 'number' || !isYouTubeWatchUrl(tab.url)) {
    return asErrorResponse('Tab is unavailable or not a YouTube watch page.');
  }

  try {
    await ensureContentScriptInjected(tab.id);
  } catch (error) {
    return asErrorResponse(toErrorMessage(error, 'Failed to inject content script.'));
  }

  const now = Date.now();
  const route: RouteState = {
    routeId: createRouteId(),
    tabId: tab.id,
    windowId: tab.windowId,
    tabTitle: tab.title ?? '',
    videoTitle: tab.title ?? '',
    url: tab.url ?? '',
    offsetSec: 0,
    targetVolumePercent: 100,
    targetMuted: false,
    appliedMuted: false,
    status: 'loading',
    currentTimeSec: 0,
    durationSec: null,
    lastSnapshot: null,
    lastError: null,
    importedAtMs: now,
    updatedAtMs: now,
  };

  routesById.set(route.routeId, route);
  routeIdByTabId.set(route.tabId, route.routeId);

  ensureSessionRouteRefs();
  emitSessionUpdated('route-imported');

  return {
    ok: true,
    route: cloneRoute(route),
  };
}

function removeRouteByRouteId(routeId: string, reason = 'route-removed'): boolean {
  const route = routesById.get(routeId);
  if (!route) {
    return false;
  }

  routesById.delete(routeId);
  routeIdByTabId.delete(route.tabId);
  ensureSessionRouteRefs();

  emitRuntimeMessage({
    type: BG_EVENT.ROUTE_INVALIDATED,
    payload: {
      reason,
      routeId,
      tabId: route.tabId,
    },
  });

  emitSessionUpdated(reason);
  return true;
}

function setMainRouteWithEquivalentOffsets(routeId: string): ControllerResponse {
  const newMainRoute = routesById.get(routeId);

  if (!newMainRoute) {
    return asErrorResponse('Route not found.');
  }

  const shiftSec = newMainRoute.offsetSec;
  const updatedAtMs = Date.now();

  routesById.forEach((route) => {
    route.offsetSec = normalizeOffsetSeconds(route.offsetSec - shiftSec);
    route.updatedAtMs = updatedAtMs;
  });

  sessionState.mainRouteId = routeId;
  emitSessionUpdated('main-route-changed');

  return {
    ok: true,
    session: buildSessionSnapshot(),
  };
}

function setRouteOffset(routeId: string, offsetSec: number): ControllerResponse {
  const route = routesById.get(routeId);

  if (!route) {
    return asErrorResponse('Route not found.');
  }

  route.offsetSec = normalizeOffsetSeconds(offsetSec);
  route.updatedAtMs = Date.now();

  emitSessionUpdated('route-offset-updated');

  return {
    ok: true,
    session: buildSessionSnapshot(),
  };
}

async function setRouteVolume(routeId: string, volumePercent: number): Promise<ControllerResponse> {
  const route = routesById.get(routeId);

  if (!route) {
    return asErrorResponse('Route not found.');
  }

  const normalizedVolumePercent = normalizeVolumePercent(volumePercent);
  const previousVolumePercent = route.targetVolumePercent;

  route.targetVolumePercent = normalizedVolumePercent;
  route.updatedAtMs = Date.now();

  const commandResponse = await executeRouteCommand(routeId, ROUTE_COMMAND.SET_VOLUME, {
    volumePercent: normalizedVolumePercent,
  });

  if (!commandResponse.ok) {
    route.targetVolumePercent = previousVolumePercent;
    route.updatedAtMs = Date.now();
    emitSessionUpdated('route-volume-update-failed');
    return commandResponse;
  }

  emitSessionUpdated('route-volume-updated');

  return {
    ok: true,
    session: buildSessionSnapshot(),
  };
}

async function setRouteMuted(routeId: string, isMuted: boolean): Promise<ControllerResponse> {
  const route = routesById.get(routeId);

  if (!route) {
    return asErrorResponse('Route not found.');
  }

  const previousTargetMuted = route.targetMuted;
  const previousAppliedMuted = route.appliedMuted;

  route.targetMuted = isMuted;
  route.appliedMuted = resolveAppliedMuted(route.routeId, route.targetMuted);
  route.updatedAtMs = Date.now();

  const commandResponse = await executeRouteCommand(routeId, ROUTE_COMMAND.SET_MUTED, {
    isMuted: route.appliedMuted,
  });

  if (!commandResponse.ok) {
    route.targetMuted = previousTargetMuted;
    route.appliedMuted = previousAppliedMuted;
    route.updatedAtMs = Date.now();
    emitSessionUpdated('route-muted-update-failed');
    return commandResponse;
  }

  emitSessionUpdated('route-muted-updated');

  return {
    ok: true,
    session: buildSessionSnapshot(),
  };
}

async function setSoloRoute(routeId: string | null): Promise<ControllerResponse> {
  if (routeId !== null && !routesById.has(routeId)) {
    return asErrorResponse('Route not found.');
  }

  sessionState.soloRouteId = routeId;

  const results = await Promise.allSettled(
    Array.from(routesById.values()).map((route) => applyEffectiveMutedState(route)),
  );

  const hasAnyTransportError = results.some(
    (result) => result.status === 'fulfilled' && result.value !== null && !result.value.ok,
  );

  if (hasAnyTransportError) {
    emitSessionUpdated('solo-route-updated-with-errors');
  } else {
    emitSessionUpdated('solo-route-updated');
  }

  return {
    ok: true,
    session: buildSessionSnapshot(),
  };
}

async function focusRouteTab(routeId: string): Promise<ControllerResponse> {
  const route = routesById.get(routeId);
  if (!route) {
    return asErrorResponse('Route not found.');
  }

  try {
    const updatedTab = await chrome.tabs.update(route.tabId, { active: true });
    const nextWindowId =
      typeof updatedTab.windowId === 'number'
        ? updatedTab.windowId
        : typeof route.windowId === 'number'
          ? route.windowId
          : null;

    if (typeof nextWindowId === 'number') {
      await chrome.windows.update(nextWindowId, {
        focused: true,
        state: 'normal',
      });
      route.windowId = nextWindowId;
      sourceWindowId = nextWindowId;
    }

    route.updatedAtMs = Date.now();
    emitSessionUpdated('route-tab-focused');

    return {
      ok: true,
      session: buildSessionSnapshot(),
    };
  } catch (error) {
    return asErrorResponse(toErrorMessage(error, 'Failed to focus route tab.'));
  }
}

async function executeRouteCommand(
  routeId: string,
  command: RouteCommand,
  args: RouteCommandArgs = {},
): Promise<ControllerResponse> {
  const route = routesById.get(routeId);

  if (!route) {
    return asErrorResponse('Route does not exist.');
  }

  try {
    const message: BackgroundToContentMessage = {
      type: BG_TO_CONTENT.EXECUTE_COMMAND,
      payload: {
        command,
        args,
      },
    };

    let rawResponse: unknown;

    try {
      rawResponse = await chrome.tabs.sendMessage(route.tabId, message);
    } catch (error) {
      if (!isReceivingEndMissingError(error)) {
        throw error;
      }

      await ensureContentScriptInjected(route.tabId);
      rawResponse = await chrome.tabs.sendMessage(route.tabId, message);
    }

    const response = parseContentCommandResponse(rawResponse);

    if (!response) {
      route.lastError = 'Malformed command response from content script.';
      route.updatedAtMs = Date.now();
      emitSessionUpdated('route-command-malformed-response');
      return asErrorResponse(route.lastError);
    }

    if (!response.ok) {
      route.lastError = response.error;
      route.updatedAtMs = Date.now();
      emitSessionUpdated('route-command-failed');
      return asErrorResponse(response.error);
    }

    updateRouteSnapshot(route, response.snapshot);
    route.updatedAtMs = Date.now();
    emitSessionUpdated('route-command-success');

    return {
      ok: true,
      snapshot: response.snapshot,
    };
  } catch (error) {
    route.lastError = toErrorMessage(error, 'Failed to contact tab content script.');
    route.updatedAtMs = Date.now();
    emitSessionUpdated('route-command-transport-error');

    return asErrorResponse(route.lastError);
  }
}

async function handleControllerMessage(message: ControllerToBackgroundMessage): Promise<ControllerResponse> {
  switch (message.type) {
    case CONTROLLER_TO_BG.HELLO:
      return {
        ok: true,
        version: chrome.runtime.getManifest().version,
      };

    case CONTROLLER_TO_BG.LIST_YOUTUBE_TABS:
      return {
        ok: true,
        tabs: await listYouTubeTabs(message.payload?.scope ?? TAB_SCAN_SCOPE.ALL_WINDOWS),
      };

    case CONTROLLER_TO_BG.IMPORT_TAB:
      return importTab(message.payload.tabId);

    case CONTROLLER_TO_BG.REMOVE_ROUTE: {
      const removed = removeRouteByRouteId(message.payload.routeId, 'route-removed-by-user');

      if (!removed) {
        return asErrorResponse('Route not found.');
      }

      return { ok: true };
    }

    case CONTROLLER_TO_BG.SET_MAIN_ROUTE:
      return setMainRouteWithEquivalentOffsets(message.payload.routeId);

    case CONTROLLER_TO_BG.SET_ROUTE_OFFSET:
      return setRouteOffset(message.payload.routeId, message.payload.offsetSec);

    case CONTROLLER_TO_BG.SET_ROUTE_VOLUME:
      return setRouteVolume(message.payload.routeId, message.payload.volumePercent);

    case CONTROLLER_TO_BG.SET_ROUTE_MUTED:
      return setRouteMuted(message.payload.routeId, message.payload.isMuted);

    case CONTROLLER_TO_BG.SET_SOLO_ROUTE:
      return setSoloRoute(message.payload.routeId);

    case CONTROLLER_TO_BG.FOCUS_ROUTE_TAB:
      return focusRouteTab(message.payload.routeId);

    case CONTROLLER_TO_BG.ROUTE_COMMAND:
      return executeRouteCommand(message.payload.routeId, message.payload.command, message.payload.args ?? {});

    case CONTROLLER_TO_BG.GET_SESSION:
      ensureSessionRouteRefs();
      return {
        ok: true,
        session: buildSessionSnapshot(),
      };

    default:
      return asErrorResponse('Unknown controller message type.');
  }
}

function handleContentPlayerEvent(sender: chrome.runtime.MessageSender, message: ContentPlayerEventMessage): void {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    return;
  }

  const route = findRouteByTabId(tabId);
  if (!route) {
    return;
  }

  updateRouteSnapshot(route, message.payload.snapshot);
  route.updatedAtMs = Date.now();
  emitSessionUpdated(`player-event:${message.payload.reason}`);
}

chrome.runtime.onInstalled.addListener(() => {
  // Keep startup behavior explicit for easier debugging.
  ensureSessionRouteRefs();
});

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.windowId === 'number' && !isExtensionInternalUrl(tab.url)) {
    sourceWindowId = tab.windowId;
  }

  void openOrFocusControllerWindow().catch((error) => {
    console.error('Failed to open controller window:', toErrorMessage(error, 'Unknown error'));
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const contentPlayerEvent = parseContentPlayerEventMessage(message);

  if (contentPlayerEvent) {
    handleContentPlayerEvent(sender, contentPlayerEvent);
    sendResponse({ ok: true });
    return false;
  }

  const controllerMessage = parseControllerMessage(message);

  if (!controllerMessage) {
    sendResponse(asErrorResponse('Malformed message.'));
    return false;
  }

  void handleControllerMessage(controllerMessage)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      sendResponse(asErrorResponse(toErrorMessage(error, 'Background handler failed.')));
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const route = findRouteByTabId(tabId);
  if (!route) {
    return;
  }

  removeRouteByRouteId(route.routeId, 'tab-closed');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const route = findRouteByTabId(tabId);
  if (!route) {
    return;
  }

  if (changeInfo.url && !isYouTubeWatchUrl(changeInfo.url)) {
    removeRouteByRouteId(route.routeId, 'tab-navigated-away');
    return;
  }

  if (typeof tab.title === 'string') {
    route.tabTitle = tab.title;

    if (!route.videoTitle) {
      route.videoTitle = tab.title;
    }

    route.updatedAtMs = Date.now();
    emitSessionUpdated('tab-title-updated');
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === controllerWindowId) {
    controllerWindowId = null;
  }

  if (windowId === sourceWindowId) {
    sourceWindowId = null;
  }
});
