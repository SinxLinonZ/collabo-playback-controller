# YouTube Multi-View Archive Sync Controller (v0.2)

Chrome Extension for synchronizing multiple YouTube archive tabs, designed for collab rewatch workflows (especially VTuber multi-perspective streams).

## Why This Exists

Heavy viewers usually already watch in native YouTube tabs and rely on:

- logged-in account state
- preferred quality settings
- existing browser extensions (ad-block, shortcuts, etc.)

Traditional iframe-grid approaches are convenient for layout, but often weaker in playback quality behavior and ecosystem compatibility.  
This project takes an extension-first approach and controls your existing watch tabs directly (`TabSync Mode`).

## Use Cases

- Rewatch a multi-perspective collab archive and keep all POVs aligned
- Compare reactions or timing differences across participants
- Manually align tabs by eye/ear, then capture offsets from actual tab states
- Keep one route as the main reference while preserving equivalent timing across all routes

## Problems Solved

- Removes repetitive per-tab manual operations (`play/pause/seek` one by one)
- Provides a single control surface for multiple YouTube watch tabs
- Makes offset tuning practical with direct edit, step controls, and reverse readback
- Reduces controller friction by using a compact dedicated window (not a transient action popup)
- Improves reliability with reinjection and retry paths when content-script endpoints disappear

## Current Capabilities

- Scan/import YouTube watch tabs from current window or all windows
- Session route management (import/remove route)
- Global controls: `Play All`, `Pause All`, `Seek All`, `Sync Now`
- Main route switching with equivalent offset conversion
- Per-route offset editing:
- direct signed input (`seconds`, `mm:ss`, `hh:mm:ss`)
- step buttons (`-1s`, `-0.1s`, `+0.1s`, `+1s`, reset to `0`)
- `Read Offsets` to capture offsets from current tab times

## Technical Architecture

The extension is split into 3 runtime layers:

1. `Controller Page` (React + TypeScript)
- UI state, session view, route actions
- global commands and offset workflows

2. `Background Service Worker` (TypeScript)
- tab discovery and lifecycle handling
- route/session ownership
- message routing and resilience (ping/inject/retry)

3. `Content Script` (TypeScript, injected into YouTube watch pages)
- controls native `<video>` (`play`, `pause`, `seek`, `volume`, `mute`, `playbackRate`)
- reports snapshots/events (`currentTime`, `duration`, `status`)

Message flow:

- `Controller -> Background -> Content` for commands
- `Content -> Background -> Controller` for snapshots/session updates

Time model:

- target time per route: `targetTime = masterTime + offset`
- `Sync Now`: one-shot immediate realignment
- `Auto Sync Correction`: planned continuous drift correction loop (not implemented yet)

## Tech Stack

- TypeScript (strict)
- React (controller UI)
- Vite + `@crxjs/vite-plugin`
- Chrome Extension Manifest V3

## Quick Start

```bash
npm install
npm run build
```

Load extension in Chrome:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `dist/`

Development:

```bash
npm run dev
```

## Current Scope vs Next Work

Implemented core `TabSync Mode` MVP path, but still pending:

- route-level `mute/volume` UI semantics
- `solo` behavior and state restore rules
- `Auto Sync Correction` engine (soft/hard correction loop)
- drift/sync-status visualization

