# Strudel Collab

Collaborative live-coding rooms with a shared Strudel editor, Yjs sync, and transport controls.

## Prerequisites

- **Node.js** 20+ (18+ may work; Strudel’s package metadata asks for 18+)
- **npm** 9+ (workspaces)

## Install

From the repository root:

```bash
npm install
```

## Development (recommended)

Runs the API/WebSocket server and the Vite dev client together. The shared package is built once before dev starts.

```bash
npm run dev
```

| Service | URL | Notes |
|--------|-----|--------|
| Web UI | [http://localhost:5173](http://localhost:5173) | Use this in the browser |
| API + WebSockets | `http://127.0.0.1:4000` | Proxied from the web app for `/api` and `/ws` |

The Vite dev server proxies:

- `http://localhost:5173/api/*` → `http://127.0.0.1:4000`
- `ws://localhost:5173/ws/*` → `ws://127.0.0.1:4000`

So you normally **only open port 5173**; you do not need to configure CORS for local dev.

### Run server and web separately (optional)

Terminal 1 — build shared once, then watch server:

```bash
npm run build -w @strudel-collab/shared
npm run dev -w @strudel-collab/server
```

Terminal 2 — web (still expects API on port 4000 for the proxy):

```bash
npm run dev -w @strudel-collab/web
```

## Production build

```bash
npm run build
```

Artifacts:

- `packages/shared/dist/` — compiled shared types/schemas
- `apps/server/dist/` — server entry `index.js`
- `apps/web/dist/` — static frontend

### Run the server (API + WebSockets only)

```bash
npm start
```

This runs `node apps/server/dist/index.js`. By default it listens on **port 4000** (override with `PORT`).

For a full production setup you still need to **serve** `apps/web/dist/` (e.g. nginx, Caddy, or static middleware). Point the browser origin at whatever serves the SPA, and ensure:

- HTTP API is reachable where the client expects it (same host with `/api` reverse proxy, or configure the client).
- WebSocket upgrades for `/ws` are proxied correctly.

The dev app assumes same-origin `/api` and `/ws`; production may need a small client config change if API and static files use different hosts.

## Environment variables

| Variable | Where | Purpose |
|----------|--------|---------|
| `PORT` | Server | HTTP/WebSocket listen port (default `4000`) |
| `REDIS_URL` | Server | Optional. If set, Yjs document snapshots are stored in Redis (24h TTL per key) in addition to in-memory behavior. |

### Optional: WebSocket URL override (web)

If you do not use the Vite proxy (e.g. custom deployment), set in `apps/web` env:

- `VITE_WS_URL` — base WebSocket URL (no trailing path). If unset, the client uses `ws(s)://` + `location.host` (same origin as the page).

## Using the app

1. Open the web UI (dev: port **5173**).
2. Enter a display name, then **Create room** or **Join** with a code.
3. Up to **4** users per room.
4. The first member is the **transport leader**; only the leader can Play / Stop / Reset / BPM (others see an error if they try).
5. Audio requires a **user gesture** (click Play); browsers block autoplay otherwise.

## Troubleshooting

- **`EADDRINUSE` / port 4000 already in use**  
  Another process (often a previous dev server) is bound to 4000.

  ```bash
  lsof -i :4000
  kill <PID>
  ```

  Or run everything on a different port (Vite reads the same `PORT` for the proxy):

  ```bash
  PORT=4001 npm run dev
  ```

- **`ws proxy socket error` / `write EPIPE` in the Vite terminal**  
  Usually means the API server stopped while the dev client still had WebSockets open (for example port conflict, or the server exited). After fixing the server, refresh the browser and run `npm run dev` again. With the default dev script, if the server exits with an error, Vite is stopped too so this is less common.

- **`npm run dev` fails on shared build**  
  Run `npm run build -w @strudel-collab/shared` and fix any TypeScript errors in `packages/shared`.

- **Web UI loads but rooms/join fail**  
  Confirm the server port matches the Vite proxy (default **4000**, or whatever you set in `PORT`).

- **WebSocket disconnects or Yjs won’t sync**  
  Ensure you connect through the **same host** as the page (5173 in dev) so `/ws` is proxied, or set `VITE_WS_URL` appropriately.

- **Console: “Yjs was already imported”**  
  Known class of warning when the server loads multiple Yjs entry points; it does not usually break runtime behavior.

## License note

`@strudel/web` is **AGPL-3.0-or-later**. If you distribute the combined app, comply with AGPL (and any other licenses of bundled dependencies).
