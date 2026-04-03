/** WebSocket base for same-host proxy (Vite) or explicit env override. */
export function getWsBase(): string {
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${p}//${location.host}`;
}
