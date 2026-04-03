export const CONTROLLER_TO_BG = {
  HELLO: 'controller/hello',
  LIST_YOUTUBE_TABS: 'controller/list-youtube-tabs',
  IMPORT_TAB: 'controller/import-tab',
  REMOVE_ROUTE: 'controller/remove-route',
  SET_MAIN_ROUTE: 'controller/set-main-route',
  SET_ROUTE_OFFSET: 'controller/set-route-offset',
  SET_ROUTE_VOLUME: 'controller/set-route-volume',
  SET_ROUTE_MUTED: 'controller/set-route-muted',
  SET_SOLO_ROUTE: 'controller/set-solo-route',
  FOCUS_ROUTE_TAB: 'controller/focus-route-tab',
  ROUTE_COMMAND: 'controller/route-command',
  GET_SESSION: 'controller/get-session',
} as const;

export const BG_TO_CONTENT = {
  PING: 'background/ping',
  EXECUTE_COMMAND: 'background/execute-command',
} as const;

export const CONTENT_TO_BG = {
  PLAYER_EVENT: 'content/player-event',
} as const;

export const BG_EVENT = {
  SESSION_UPDATED: 'background/session-updated',
  ROUTE_INVALIDATED: 'background/route-invalidated',
} as const;

export const TAB_SCAN_SCOPE = {
  CURRENT_WINDOW: 'current-window',
  ALL_WINDOWS: 'all-windows',
} as const;

export const WATCH_URL_PATTERNS = ['https://www.youtube.com/watch*'] as const;

export const ERROR_CODE = {
  MALFORMED_MESSAGE: 'MALFORMED_MESSAGE',
  UNKNOWN_MESSAGE_TYPE: 'UNKNOWN_MESSAGE_TYPE',
  BAD_REQUEST: 'BAD_REQUEST',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  TAB_NOT_AVAILABLE: 'TAB_NOT_AVAILABLE',
  TAB_NOT_WATCH_PAGE: 'TAB_NOT_WATCH_PAGE',
  CONTENT_SCRIPT_PATH_MISSING: 'CONTENT_SCRIPT_PATH_MISSING',
  CONTENT_SCRIPT_INJECTION_FAILED: 'CONTENT_SCRIPT_INJECTION_FAILED',
  CONTENT_UNREACHABLE: 'CONTENT_UNREACHABLE',
  TIMEOUT_BG_RESPONSE: 'TIMEOUT_BG_RESPONSE',
  TIMEOUT_CONTENT_RESPONSE: 'TIMEOUT_CONTENT_RESPONSE',
  MALFORMED_CONTENT_RESPONSE: 'MALFORMED_CONTENT_RESPONSE',
  STATE_AD_BLOCKING: 'STATE_AD_BLOCKING',
  STATE_NOT_SEEKABLE: 'STATE_NOT_SEEKABLE',
  VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
  UNSUPPORTED_COMMAND: 'UNSUPPORTED_COMMAND',
  COMMAND_EXECUTION_FAILED: 'COMMAND_EXECUTION_FAILED',
  WINDOW_FOCUS_FAILED: 'WINDOW_FOCUS_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const ROUTE_COMMAND = {
  PLAY: 'play',
  PAUSE: 'pause',
  SEEK: 'seek',
  SET_VOLUME: 'set-volume',
  SET_MUTED: 'set-muted',
  SET_PLAYBACK_RATE: 'set-playback-rate',
  GET_STATUS: 'get-status',
} as const;

export type TabScanScope = (typeof TAB_SCAN_SCOPE)[keyof typeof TAB_SCAN_SCOPE];
export type RouteCommand = (typeof ROUTE_COMMAND)[keyof typeof ROUTE_COMMAND];
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export type RouteStatus = 'loading' | 'playing' | 'paused' | 'buffering' | 'ad' | 'ended' | 'error';
export type RouteSpecialState = 'none' | 'ad' | 'live' | 'not-seekable' | 'no-video' | 'unknown';

export interface CandidateTab {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
}

export interface RouteSnapshot {
  status: Exclude<RouteStatus, 'error'>;
  specialState: RouteSpecialState;
  currentTimeSec: number;
  durationSec: number | null;
  playbackRate: number;
  volumePercent: number;
  isMuted: boolean;
  title: string;
  href: string;
  observedAtMs?: number;
}

export interface RouteState {
  routeId: string;
  tabId: number;
  windowId: number;
  tabTitle: string;
  videoTitle: string;
  url: string;
  offsetSec: number;
  targetVolumePercent: number;
  targetMuted: boolean;
  appliedMuted: boolean;
  status: RouteStatus;
  currentTimeSec: number;
  durationSec: number | null;
  lastSnapshot: RouteSnapshot | null;
  lastError: string | null;
  importedAtMs: number;
  updatedAtMs: number;
}

export interface SessionSnapshot {
  mainRouteId: string | null;
  soloRouteId: string | null;
  routes: RouteState[];
}

export type RouteCommandArgs = Record<string, unknown>;

export interface ControllerHelloMessage {
  type: (typeof CONTROLLER_TO_BG)['HELLO'];
}

export interface ControllerListTabsMessage {
  type: (typeof CONTROLLER_TO_BG)['LIST_YOUTUBE_TABS'];
  payload?: {
    scope?: TabScanScope;
  };
}

export interface ControllerImportTabMessage {
  type: (typeof CONTROLLER_TO_BG)['IMPORT_TAB'];
  payload: {
    tabId: number;
  };
}

export interface ControllerRemoveRouteMessage {
  type: (typeof CONTROLLER_TO_BG)['REMOVE_ROUTE'];
  payload: {
    routeId: string;
  };
}

export interface ControllerSetMainRouteMessage {
  type: (typeof CONTROLLER_TO_BG)['SET_MAIN_ROUTE'];
  payload: {
    routeId: string;
  };
}

export interface ControllerSetRouteOffsetMessage {
  type: (typeof CONTROLLER_TO_BG)['SET_ROUTE_OFFSET'];
  payload: {
    routeId: string;
    offsetSec: number;
  };
}

export interface ControllerSetRouteVolumeMessage {
  type: (typeof CONTROLLER_TO_BG)['SET_ROUTE_VOLUME'];
  payload: {
    routeId: string;
    volumePercent: number;
  };
}

export interface ControllerSetRouteMutedMessage {
  type: (typeof CONTROLLER_TO_BG)['SET_ROUTE_MUTED'];
  payload: {
    routeId: string;
    isMuted: boolean;
  };
}

export interface ControllerSetSoloRouteMessage {
  type: (typeof CONTROLLER_TO_BG)['SET_SOLO_ROUTE'];
  payload: {
    routeId: string | null;
  };
}

export interface ControllerFocusRouteTabMessage {
  type: (typeof CONTROLLER_TO_BG)['FOCUS_ROUTE_TAB'];
  payload: {
    routeId: string;
  };
}

export interface ControllerRouteCommandMessage {
  type: (typeof CONTROLLER_TO_BG)['ROUTE_COMMAND'];
  payload: {
    routeId: string;
    command: RouteCommand;
    args?: RouteCommandArgs;
  };
}

export interface ControllerGetSessionMessage {
  type: (typeof CONTROLLER_TO_BG)['GET_SESSION'];
}

export type ControllerToBackgroundMessage =
  | ControllerHelloMessage
  | ControllerListTabsMessage
  | ControllerImportTabMessage
  | ControllerRemoveRouteMessage
  | ControllerSetMainRouteMessage
  | ControllerSetRouteOffsetMessage
  | ControllerSetRouteVolumeMessage
  | ControllerSetRouteMutedMessage
  | ControllerSetSoloRouteMessage
  | ControllerFocusRouteTabMessage
  | ControllerRouteCommandMessage
  | ControllerGetSessionMessage;

export interface SuccessResponseBase {
  ok: true;
}

export interface ErrorResponse {
  ok: false;
  errorCode: ErrorCode;
  error: string;
  atMs: number;
  details?: string;
}

export interface HelloResponse extends SuccessResponseBase {
  version: string;
}

export interface ListTabsResponse extends SuccessResponseBase {
  tabs: CandidateTab[];
}

export interface ImportTabResponse extends SuccessResponseBase {
  route: RouteState;
  alreadyImported?: boolean;
}

export interface RemoveRouteResponse extends SuccessResponseBase {}

export interface SetMainRouteResponse extends SuccessResponseBase {
  session: SessionSnapshot;
}

export interface SetRouteOffsetResponse extends SuccessResponseBase {
  session: SessionSnapshot;
}

export interface SetRouteVolumeResponse extends SuccessResponseBase {
  session: SessionSnapshot;
}

export interface SetRouteMutedResponse extends SuccessResponseBase {
  session: SessionSnapshot;
}

export interface SetSoloRouteResponse extends SuccessResponseBase {
  session: SessionSnapshot;
}

export interface FocusRouteTabResponse extends SuccessResponseBase {
  session: SessionSnapshot;
}

export interface RouteCommandResponse extends SuccessResponseBase {
  snapshot: RouteSnapshot | null;
}

export interface GetSessionResponse extends SuccessResponseBase {
  session: SessionSnapshot;
}

export type ControllerResponse =
  | HelloResponse
  | ListTabsResponse
  | ImportTabResponse
  | RemoveRouteResponse
  | SetMainRouteResponse
  | SetRouteOffsetResponse
  | SetRouteVolumeResponse
  | SetRouteMutedResponse
  | SetSoloRouteResponse
  | FocusRouteTabResponse
  | RouteCommandResponse
  | GetSessionResponse
  | ErrorResponse;

export interface ContentPingMessage {
  type: (typeof BG_TO_CONTENT)['PING'];
}

export interface ContentExecuteCommandMessage {
  type: (typeof BG_TO_CONTENT)['EXECUTE_COMMAND'];
  payload: {
    command: RouteCommand;
    args?: RouteCommandArgs;
  };
}

export type BackgroundToContentMessage = ContentPingMessage | ContentExecuteCommandMessage;

export interface ContentCommandSuccess {
  ok: true;
  snapshot: RouteSnapshot;
}

export type ContentCommandResponse = ContentCommandSuccess | ErrorResponse;

export interface ContentPlayerEventMessage {
  type: (typeof CONTENT_TO_BG)['PLAYER_EVENT'];
  payload: {
    reason: string;
    snapshot: RouteSnapshot;
  };
}

export interface SessionUpdatedEvent {
  type: (typeof BG_EVENT)['SESSION_UPDATED'];
  payload: {
    reason: string;
    session: SessionSnapshot;
  };
}

export interface RouteInvalidatedEvent {
  type: (typeof BG_EVENT)['ROUTE_INVALIDATED'];
  payload: {
    reason: string;
    routeId: string;
    tabId: number;
  };
}

export type BackgroundEventMessage = SessionUpdatedEvent | RouteInvalidatedEvent;
