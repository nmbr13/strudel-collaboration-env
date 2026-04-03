# Live Performance UX — Design Spec
**Date:** 2026-04-03
**Status:** Approved

---

## Background

Strudel Collab is used for live algorave-style performances — solo performers and collaborative ensembles coding on stage with an audience watching. The current UX has two gaps that make live use risky:

1. **Eval errors stop playback** — a typo silences the room mid-performance
2. **No cycle-aligned update** — code changes land immediately, mid-pattern, which sounds wrong musically

This spec covers the changes needed to make the app safe and musical for live use.

---

## 1. Safe-by-Default Evaluation

### Behaviour
- The server maintains a `lastGoodCode` snapshot per room — the most recent code that evaluated without error
- When a performer hits **Update** and the code fails (syntax or runtime error), playback continues using `lastGoodCode` uninterrupted
- The editor retains the broken code so the performer can fix it
- A subtle inline comment in the editor marks which version is currently playing: `// ↑ last good eval — still playing`

### What changes
- Remove the current behaviour where eval errors stop or interrupt playback
- The existing `lastGoodCodeRef` in `RoomPage.tsx` already tracks last good code client-side; this needs to become authoritative server-side state so all clients agree on what's playing
- `useStrudel.runCode()` error handling: on error, do not call `strudel.stop()` — keep the current pattern running

---

## 2. Play / Stop / Update Toolbar

### Button states

| State | Buttons shown |
|---|---|
| Stopped | **Play** (green) · Update (disabled) |
| Playing, code in sync | **Stop** (red) · **Update** (purple) |
| Update queued (awaiting next cycle) | **Stop** (red) · **queued…** (pulsing, purple) |
| Playing, error state | **Stop** (red) · Update (disabled) · **Revert** (amber) |

### Play / Stop
- Same button, toggles label and colour
- **Play**: starts transport, broadcasts `transport:play` to room (leader only, existing behaviour)
- **Stop**: stops transport, broadcasts `transport:stop` (existing behaviour)

### Update
- Separate button, only enabled while transport is running and no current error
- Keyboard shortcut: `⌘↵` (replaces current behaviour of play-if-stopped / re-eval-if-playing)
- On activation: queues current editor code to evaluate at the **start of the next cycle**
- Cycle timing: uses the existing `suggestedLookaheadMs` + server clock sync already in place; schedules eval at `nextCycleAtMs` derived from current BPM and transport start time
- While queued: button shows "⟳ queued…" with a CSS pulse animation; hitting `⌘↵` again cancels the queued update
- On success: queued state clears, editor comment updates, `lastGoodCode` snapshot advances
- On error: queued state clears, error state activates (see section 3), playback continues uninterrupted

### Revert
- Only shown in error state (replaces the always-visible revert button)
- Restores `lastGoodCode` into the editor, clears error state, re-enables Update
- Existing revert logic in `RoomPage.tsx` is reused; just moved to error-state-only visibility

### Removed buttons
- The existing standalone **Revert** and **Reset** buttons are removed from the default toolbar; Revert surfaces only on error, Reset is removed entirely (covered by Stop → Play)

---

## 3. Room-Wide Error Visibility

### When an update fails

**For everyone in the room:**
- A banner appears at the top of the editor area:
  *"[name]'s update didn't land — playing last good version"*
- The erroring performer's avatar gets a red `!` badge
- The error detail (file, line number, message) is shown in a strip below the editor

**For the erroring performer specifically:**
- Same visibility as everyone else — no special treatment beyond being the one who needs to fix it
- The Revert button appears in their toolbar

### Clearing the error state
- Clears automatically when the erroring performer successfully updates (new code evaluates without error) or hits Revert
- Banner and avatar badge clear for all room members simultaneously via the existing `transport:state` / room control WebSocket

### Implementation notes
- When a client's eval fails, it sends a new client control message `client:error` — `{ message, line? }` to the server via the existing room WebSocket
- The server broadcasts `room:error` — `{ sessionId, displayName, message, line? }` to all room members including the sender
- When a client successfully updates or reverts, it sends `client:errorCleared` to the server
- The server broadcasts `room:errorCleared` — `{ sessionId }` to all room members
- Server does not persist error state — it is transient and lives only in client UI state

---

## 4. Keyboard Shortcuts (updated)

| Shortcut | Action |
|---|---|
| `⌘↵` | Update (queue code for next cycle) — replaces current play/re-eval behaviour |
| `⌘.` | Stop — unchanged |
| `⌘⇧Z` | Revert — unchanged, still works in error state |

---

## 5. Out of Scope

- Per-performer code lanes or slot ownership
- Cue system / leader-controlled merge
- Mobile / small screen layout
- Performance / focus mode (full-screen editor)

These may be worth revisiting in a future iteration once the core eval safety model is in place.

---

## Files Affected

| File | Change |
|---|---|
| `apps/web/src/pages/RoomPage.tsx` | Toolbar restructure, Update button + queued state, error state UI, keyboard shortcut changes |
| `apps/web/src/hooks/useStrudel.ts` | Error handling: keep playback on error, don't call stop() |
| `apps/web/src/hooks/useRoomControl.ts` | Handle `room:error` and `room:errorCleared` messages, broadcast error state |
| `apps/server/src/rooms.ts` | New control messages: `room:error`, `room:errorCleared`; broadcast on receipt |
| `packages/shared/src/index.ts` | Add Zod schemas for `room:error` and `room:errorCleared` message types |
