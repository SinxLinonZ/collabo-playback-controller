import {
  BG_TO_CONTENT,
  CONTENT_TO_BG,
  ROUTE_COMMAND,
  type ContentCommandResponse,
  type ContentPlayerEventMessage,
  type RouteCommand,
  type RouteCommandArgs,
  type RouteSnapshot,
} from '../shared/protocol.js';

const HEARTBEAT_MS = 500;
const INIT_FLAG = '__YT_ARCHIVE_SYNC_CONTENT_INITIALIZED__';
const ROUTE_COMMAND_VALUES = Object.values(ROUTE_COMMAND) as RouteCommand[];

type ContentWindow = Window & {
  [INIT_FLAG]?: boolean;
};

const contentWindow = window as ContentWindow;

if (contentWindow[INIT_FLAG]) {
  // Skip duplicate initialization when executeScript runs more than once.
} else {
  contentWindow[INIT_FLAG] = true;
  bootstrap();
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isRouteCommand(value: unknown): value is RouteCommand {
  return typeof value === 'string' && ROUTE_COMMAND_VALUES.includes(value as RouteCommand);
}

function toSafeNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function resolveStatus(video: HTMLVideoElement | null): RouteSnapshot['status'] {
  if (!video) {
    return 'loading';
  }

  if (video.readyState < 2) {
    return 'buffering';
  }

  if (video.paused || video.ended) {
    return 'paused';
  }

  return 'playing';
}

function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector('video');
}

function readSnapshot(): RouteSnapshot {
  const video = getVideoElement();

  if (!video) {
    return {
      status: 'loading',
      currentTimeSec: 0,
      durationSec: null,
      playbackRate: 1,
      volumePercent: 100,
      isMuted: false,
      title: document.title,
      href: location.href,
    };
  }

  return {
    status: resolveStatus(video),
    currentTimeSec: toSafeNumber(video.currentTime, 0),
    durationSec: Number.isFinite(video.duration) ? video.duration : null,
    playbackRate: toSafeNumber(video.playbackRate, 1),
    volumePercent: Math.round(toSafeNumber(video.volume, 1) * 100),
    isMuted: Boolean(video.muted),
    title: document.title,
    href: location.href,
  };
}

function asErrorResponse(error: string): ContentCommandResponse {
  return {
    ok: false,
    error,
  };
}

function toCommandNumberArg(args: RouteCommandArgs, key: string): number | null {
  const raw = args[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }

  return raw;
}

async function executeCommand(command: RouteCommand, args: RouteCommandArgs = {}): Promise<ContentCommandResponse> {
  const video = getVideoElement();

  if (command === ROUTE_COMMAND.GET_STATUS) {
    return {
      ok: true,
      snapshot: readSnapshot(),
    };
  }

  if (!video) {
    return asErrorResponse('No video element found on current page.');
  }

  try {
    switch (command) {
      case ROUTE_COMMAND.PLAY:
        await video.play();
        break;

      case ROUTE_COMMAND.PAUSE:
        video.pause();
        break;

      case ROUTE_COMMAND.SEEK: {
        const targetSec = toCommandNumberArg(args, 'timeSec');
        if (targetSec === null) {
          return asErrorResponse('Invalid seek target.');
        }

        const maxDuration = Number.isFinite(video.duration) ? video.duration : targetSec;
        const clamped = Math.max(0, Math.min(targetSec, maxDuration));
        video.currentTime = clamped;
        break;
      }

      case ROUTE_COMMAND.SET_VOLUME: {
        const volumePercent = toCommandNumberArg(args, 'volumePercent');
        if (volumePercent === null) {
          return asErrorResponse('Invalid volume value.');
        }

        const clamped = Math.max(0, Math.min(100, volumePercent));
        video.volume = clamped / 100;
        break;
      }

      case ROUTE_COMMAND.SET_MUTED:
        video.muted = Boolean(args.isMuted);
        break;

      case ROUTE_COMMAND.SET_PLAYBACK_RATE: {
        const playbackRate = toCommandNumberArg(args, 'playbackRate');
        if (playbackRate === null) {
          return asErrorResponse('Invalid playbackRate.');
        }

        const clamped = Math.max(0.25, Math.min(2, playbackRate));
        video.playbackRate = clamped;
        break;
      }

      default:
        return asErrorResponse('Unsupported command.');
    }

    return {
      ok: true,
      snapshot: readSnapshot(),
    };
  } catch (error) {
    return asErrorResponse(toErrorMessage(error, 'Command execution failed.'));
  }
}

function sendPlayerEvent(reason: string): void {
  const message: ContentPlayerEventMessage = {
    type: CONTENT_TO_BG.PLAYER_EVENT,
    payload: {
      reason,
      snapshot: readSnapshot(),
    },
  };

  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}

function bootstrap(): void {
  let observedVideo: HTMLVideoElement | null = null;
  const observedHandlers: Array<{ event: string; handler: EventListener }> = [];

  function detachVideoEvents(): void {
    if (!observedVideo) {
      return;
    }

    observedHandlers.forEach(({ event, handler }) => {
      observedVideo?.removeEventListener(event, handler);
    });

    observedHandlers.length = 0;
    observedVideo = null;
  }

  function attachVideoEvents(video: HTMLVideoElement): void {
    const events = ['play', 'pause', 'seeking', 'seeked', 'waiting', 'ratechange', 'volumechange', 'ended'];

    events.forEach((event) => {
      const handler: EventListener = () => {
        sendPlayerEvent(`video-${event}`);
      };

      video.addEventListener(event, handler);
      observedHandlers.push({ event, handler });
    });
  }

  function refreshObservedVideo(): void {
    const video = getVideoElement();

    if (video === observedVideo) {
      return;
    }

    detachVideoEvents();

    if (video) {
      observedVideo = video;
      attachVideoEvents(video);
      sendPlayerEvent('video-detected');
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isObjectRecord(message) || typeof message.type !== 'string') {
      sendResponse(asErrorResponse('Malformed message.'));
      return false;
    }

    if (message.type === BG_TO_CONTENT.PING) {
      sendResponse({
        ok: true,
        snapshot: readSnapshot(),
      });
      return false;
    }

    if (message.type === BG_TO_CONTENT.EXECUTE_COMMAND) {
      if (!isObjectRecord(message.payload) || !isRouteCommand(message.payload.command)) {
        sendResponse(asErrorResponse('Malformed command payload.'));
        return false;
      }

      const args = isObjectRecord(message.payload.args) ? message.payload.args : {};

      void executeCommand(message.payload.command, args)
        .then((response) => {
          sendResponse(response);
        })
        .catch((error) => {
          sendResponse(asErrorResponse(toErrorMessage(error, 'Unexpected content script failure.')));
        });

      return true;
    }

    sendResponse(asErrorResponse('Unknown content script message type.'));
    return false;
  });

  setInterval(() => {
    refreshObservedVideo();
    sendPlayerEvent('heartbeat');
  }, HEARTBEAT_MS);

  refreshObservedVideo();
  sendPlayerEvent('initialized');
}
