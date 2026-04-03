import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire, type Module } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createRoomResponseSchema,
  joinRoomBodySchema,
  joinRoomResponseSchema,
  roomInfoResponseSchema,
  MAX_ROOM_MEMBERS,
} from '@strudel-collab/shared';
import { initPersistence } from './persistence.js';
import { allowRate } from './rateLimit.js';
import {
  attachControlSocket,
  broadcastRoster,
  getSessionByToken,
  createRoom,
  getRoomByCode,
  getRoomById,
  handleControlMessage,
  joinRoom,
  parseRoomIdFromYjsPath,
  rosterPayload,
  scheduleControlDisconnect,
  sendControl,
  validateTokenForRoom,
} from './rooms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Serve the built Vite frontend from the same process in production
const webDistPath = join(__dirname, '../../web/dist');
const serveStatic = existsSync(webDistPath)
  ? sirv(webDistPath, { single: true, gzip: true })
  : null;

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWSConnection } = require('y-websocket/bin/utils') as {
  setupWSConnection: (
    ws: WebSocket,
    req: IncomingMessage,
    opts?: { docName?: string; gc?: boolean },
  ) => void;
};

const PORT = Number(process.env.PORT) || 4000;

function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string') return xf.split(',')[0]?.trim() ?? 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
}

function readJsonBody(req: IncomingMessage, max = 16_384): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function corsHeaders(origin?: string): Record<string, string> {
  const o = origin ?? '*';
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function parseTokenFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, 'http://localhost');
    return u.searchParams.get('token');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await initPersistence();

  const wssYjs = new WebSocketServer({ noServer: true });
  const wssRoom = new WebSocketServer({ noServer: true });

  wssYjs.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';
    const roomId = parseRoomIdFromYjsPath(path);
    const token = parseTokenFromUrl(url);
    if (!roomId || !token) {
      ws.close(4001, 'bad handshake');
      return;
    }
    if (!validateTokenForRoom(token, roomId)) {
      ws.close(4003, 'unauthorized');
      return;
    }
    setupWSConnection(ws, req, { docName: roomId });
  });

  wssRoom.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const token = parseTokenFromUrl(req.url);
    if (!token) {
      ws.close(4001, 'bad handshake');
      return;
    }
    const sess = getSessionByToken(token);
    if (!sess) {
      ws.close(4003, 'unauthorized');
      return;
    }
    const room = getRoomById(sess.roomId);
    if (!room) {
      ws.close(4004, 'room gone');
      return;
    }
    const attached = attachControlSocket(sess.roomId, sess.sessionId, ws);
    if (!attached) {
      ws.close(4004, 'session gone');
      return;
    }

    sendControl(ws, {
      type: 'welcome',
      sessionId: sess.sessionId,
      leaderSessionId: room.leaderSessionId,
      serverTimeMs: Date.now(),
    });
    sendControl(ws, rosterPayload(room));
    broadcastRoster(room);

    ws.on('message', (data) => {
      try {
        const raw = JSON.parse(String(data)) as unknown;
        handleControlMessage(room, sess.sessionId, raw);
      } catch {
        /* ignore */
      }
    });

    ws.on('close', () => {
      scheduleControlDisconnect(sess.roomId, sess.sessionId);
    });
  });

  const httpServer = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const h = { 'Content-Type': 'application/json', ...corsHeaders(origin) };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, h);
      res.end();
      return;
    }

    const url = req.url ?? '';
    const path = url.split('?')[0];

    try {
      if (req.method === 'POST' && path === '/api/rooms') {
        const ip = clientIp(req);
        if (!allowRate(`create:${ip}`, 30, 60_000)) {
          res.writeHead(429, h);
          res.end(JSON.stringify({ error: 'RATE_LIMIT' }));
          return;
        }
        const out = createRoom();
        res.writeHead(201, h);
        res.end(JSON.stringify(createRoomResponseSchema.parse(out)));
        return;
      }

      if (req.method === 'POST' && path?.startsWith('/api/rooms/') && path.endsWith('/join')) {
        const ip = clientIp(req);
        if (!allowRate(`join:${ip}`, 60, 60_000)) {
          res.writeHead(429, h);
          res.end(JSON.stringify({ error: 'RATE_LIMIT' }));
          return;
        }
        const code = path.replace('/api/rooms/', '').replace(/\/join$/, '');
        const body = joinRoomBodySchema.parse(await readJsonBody(req));
        const result = joinRoom(code, body.displayName);
        if (!result.ok) {
          const status = result.reason === 'ROOM_NOT_FOUND' ? 404 : 403;
          res.writeHead(status, h);
          res.end(JSON.stringify({ error: result.reason }));
          return;
        }
        const payload = {
          roomId: result.room.id,
          code: result.room.code,
          sessionId: result.sessionId,
          sessionToken: result.token,
        };
        res.writeHead(200, h);
        res.end(JSON.stringify(joinRoomResponseSchema.parse(payload)));
        return;
      }

      if (req.method === 'GET' && path?.startsWith('/api/rooms/') && !path.endsWith('/join')) {
        const code = path.replace('/api/rooms/', '');
        const room = getRoomByCode(code);
        if (!room) {
          res.writeHead(200, h);
          res.end(JSON.stringify(roomInfoResponseSchema.parse({ exists: false, memberCount: 0, full: false })));
          return;
        }
        const memberCount = room.members.size;
        res.writeHead(200, h);
        res.end(
          JSON.stringify(
            roomInfoResponseSchema.parse({
              exists: true,
              memberCount,
              full: memberCount >= MAX_ROOM_MEMBERS,
            }),
          ),
        );
        return;
      }

      // Fall through to static file serving (SPA) or 404
      if (serveStatic) {
        serveStatic(req, res, () => {
          res.writeHead(404, h);
          res.end(JSON.stringify({ error: 'NOT_FOUND' }));
        });
      } else {
        res.writeHead(404, h);
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      }
    } catch (e) {
      res.writeHead(400, h);
      res.end(JSON.stringify({ error: 'BAD_REQUEST' }));
    }
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0] ?? '';

    if (path.startsWith('/ws/yjs/')) {
      wssYjs.handleUpgrade(request, socket, head, (ws) => {
        wssYjs.emit('connection', ws, request);
      });
      return;
    }

    if (path === '/ws/room') {
      wssRoom.handleUpgrade(request, socket, head, (ws) => {
        wssRoom.emit('connection', ws, request);
      });
      return;
    }

    socket.destroy();
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[server] Port ${PORT} is already in use.\n` +
          `  • Stop the other process:  lsof -i :${PORT}   then   kill <PID>\n` +
          `  • Or use another port:       PORT=4001 npm run dev`,
      );
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
