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
  type RouteState,
  type SessionSnapshot,
} from '../shared/protocol.js';

interface ViewElements {
  scanScope: HTMLSelectElement;
  scanTabsBtn: HTMLButtonElement;
  candidateTabs: HTMLUListElement;
  refreshSessionBtn: HTMLButtonElement;
  playAllBtn: HTMLButtonElement;
  pauseAllBtn: HTMLButtonElement;
  syncNowBtn: HTMLButtonElement;
  sessionRoutes: HTMLUListElement;
  statusText: HTMLSpanElement;
}

interface ViewState {
  candidates: CandidateTab[];
  session: SessionSnapshot;
}

function mustQuery<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);

  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
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

const elements: ViewElements = {
  scanScope: mustQuery<HTMLSelectElement>('#scanScope'),
  scanTabsBtn: mustQuery<HTMLButtonElement>('#scanTabsBtn'),
  candidateTabs: mustQuery<HTMLUListElement>('#candidateTabs'),
  refreshSessionBtn: mustQuery<HTMLButtonElement>('#refreshSessionBtn'),
  playAllBtn: mustQuery<HTMLButtonElement>('#playAllBtn'),
  pauseAllBtn: mustQuery<HTMLButtonElement>('#pauseAllBtn'),
  syncNowBtn: mustQuery<HTMLButtonElement>('#syncNowBtn'),
  sessionRoutes: mustQuery<HTMLUListElement>('#sessionRoutes'),
  statusText: mustQuery<HTMLSpanElement>('#statusText'),
};

const state: ViewState = {
  candidates: [],
  session: {
    mainRouteId: null,
    soloRouteId: null,
    routes: [],
  },
};

function setStatus(text: string): void {
  elements.statusText.textContent = text;
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

function createEmptyItem(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function getImportedTabIds(): Set<number> {
  return new Set(state.session.routes.map((route) => route.tabId));
}

function renderCandidates(): void {
  elements.candidateTabs.replaceChildren();

  if (state.candidates.length === 0) {
    elements.candidateTabs.appendChild(createEmptyItem('No candidate tabs.'));
    return;
  }

  const importedTabIds = getImportedTabIds();

  state.candidates.forEach((tab) => {
    const li = document.createElement('li');
    li.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';

    const title = document.createElement('p');
    title.className = 'title';
    title.textContent = tab.title || '(Untitled tab)';

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.textContent = importedTabIds.has(tab.tabId) ? 'Imported' : 'Import';
    importBtn.disabled = importedTabIds.has(tab.tabId);
    importBtn.addEventListener('click', () => {
      void handleImportTab(tab.tabId);
    });

    head.append(title, importBtn);

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `tab:${tab.tabId} | window:${tab.windowId} | ${tab.url}`;

    li.append(head, meta);
    elements.candidateTabs.appendChild(li);
  });
}

function renderSessionRoutes(): void {
  elements.sessionRoutes.replaceChildren();

  if (state.session.routes.length === 0) {
    elements.sessionRoutes.appendChild(createEmptyItem('No imported routes.'));
    return;
  }

  state.session.routes.forEach((route) => {
    const li = document.createElement('li');
    li.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';

    const title = document.createElement('p');
    title.className = 'title';
    title.textContent = route.videoTitle || route.tabTitle || '(Unknown title)';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      void handleRemoveRoute(route.routeId);
    });

    head.append(title, removeBtn);

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = [
      `route:${route.routeId}`,
      `tab:${route.tabId}`,
      `status:${route.status}`,
      `time:${formatTime(route.currentTimeSec)}`,
    ].join(' | ');

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.textContent = 'Play';
    playBtn.addEventListener('click', () => {
      void handleRouteCommand(route.routeId, ROUTE_COMMAND.PLAY);
    });

    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.textContent = 'Pause';
    pauseBtn.addEventListener('click', () => {
      void handleRouteCommand(route.routeId, ROUTE_COMMAND.PAUSE);
    });

    const pullBtn = document.createElement('button');
    pullBtn.type = 'button';
    pullBtn.textContent = 'Pull Status';
    pullBtn.addEventListener('click', () => {
      void handleRouteCommand(route.routeId, ROUTE_COMMAND.GET_STATUS);
    });

    actions.append(playBtn, pauseBtn, pullBtn);
    li.append(head, meta, actions);
    elements.sessionRoutes.appendChild(li);
  });
}

function applySessionSnapshot(session: SessionSnapshot): void {
  state.session = session;
  renderSessionRoutes();
  renderCandidates();
}

async function refreshSession(): Promise<void> {
  const response = await sendToBackground({ type: CONTROLLER_TO_BG.GET_SESSION });

  if (isErrorResponse(response)) {
    throw new Error(response.error);
  }

  if (!('session' in response)) {
    throw new Error('Unexpected session response shape.');
  }

  applySessionSnapshot(response.session);
}

async function handleScanTabs(): Promise<void> {
  try {
    setStatus('Scanning YouTube watch tabs...');

    const response = await sendToBackground({
      type: CONTROLLER_TO_BG.LIST_YOUTUBE_TABS,
      payload: {
        scope: (elements.scanScope.value as typeof TAB_SCAN_SCOPE[keyof typeof TAB_SCAN_SCOPE]) ||
          TAB_SCAN_SCOPE.ALL_WINDOWS,
      },
    });

    if (isErrorResponse(response)) {
      throw new Error(response.error);
    }

    if (!('tabs' in response)) {
      throw new Error('Unexpected tab list response shape.');
    }

    state.candidates = response.tabs;
    renderCandidates();
    setStatus(`Scanned ${state.candidates.length} tab(s).`);
  } catch (error) {
    setStatus(toErrorMessage(error, 'Scan failed.'));
  }
}

async function handleImportTab(tabId: number): Promise<void> {
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
    renderCandidates();

    const alreadyImported = 'alreadyImported' in response && response.alreadyImported === true;
    setStatus(alreadyImported ? `Tab ${tabId} already imported.` : `Tab ${tabId} imported.`);
  } catch (error) {
    setStatus(toErrorMessage(error, 'Import failed.'));
  }
}

async function handleRemoveRoute(routeId: string): Promise<void> {
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
}

async function handleRouteCommand(routeId: string, command: RouteCommand): Promise<void> {
  const response = await sendToBackground({
    type: CONTROLLER_TO_BG.ROUTE_COMMAND,
    payload: {
      routeId,
      command,
      args: {},
    },
  });

  if (isErrorResponse(response)) {
    throw new Error(response.error);
  }
}

async function runAllRoutesCommand(command: RouteCommand): Promise<void> {
  if (state.session.routes.length === 0) {
    setStatus('No routes in session.');
    return;
  }

  setStatus(`Running ${command} for ${state.session.routes.length} route(s)...`);

  const results = await Promise.allSettled(
    state.session.routes.map((route) => handleRouteCommand(route.routeId, command)),
  );

  const successCount = results.filter((result) => result.status === 'fulfilled').length;
  const failedCount = results.length - successCount;

  await refreshSession();

  if (failedCount === 0) {
    setStatus(`Command ${command} finished for all routes.`);
    return;
  }

  setStatus(`Command ${command}: ${successCount} success, ${failedCount} failed.`);
}

function bindEvents(): void {
  elements.scanTabsBtn.addEventListener('click', () => {
    void handleScanTabs();
  });

  elements.refreshSessionBtn.addEventListener('click', () => {
    void refreshSession()
      .then(() => {
        setStatus('Session refreshed.');
      })
      .catch((error) => {
        setStatus(toErrorMessage(error, 'Refresh failed.'));
      });
  });

  elements.playAllBtn.addEventListener('click', () => {
    void runAllRoutesCommand(ROUTE_COMMAND.PLAY).catch((error) => {
      setStatus(toErrorMessage(error, 'Play all failed.'));
    });
  });

  elements.pauseAllBtn.addEventListener('click', () => {
    void runAllRoutesCommand(ROUTE_COMMAND.PAUSE).catch((error) => {
      setStatus(toErrorMessage(error, 'Pause all failed.'));
    });
  });

  elements.syncNowBtn.addEventListener('click', () => {
    void runAllRoutesCommand(ROUTE_COMMAND.GET_STATUS).catch((error) => {
      setStatus(toErrorMessage(error, 'Sync now failed.'));
    });
  });
}

function bindRuntimeEvents(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
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
          // Ignore secondary errors from background refresh.
        });
        return;
      }

      default:
        return;
    }
  });
}

async function init(): Promise<void> {
  bindEvents();
  bindRuntimeEvents();

  try {
    const hello = await sendToBackground({ type: CONTROLLER_TO_BG.HELLO });

    if (isErrorResponse(hello)) {
      throw new Error(hello.error);
    }

    if (!('version' in hello)) {
      throw new Error('Unexpected hello response shape.');
    }

    await refreshSession();
    await handleScanTabs();

    setStatus(`Connected. Extension v${hello.version}.`);
  } catch (error) {
    setStatus(toErrorMessage(error, 'Initialization failed.'));
  }
}

void init();
