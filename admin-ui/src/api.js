// API-Zugriff: CSRF-Token, verständliche Fehler (kein Fachjargon, keine Codes).
export const state = { user: null, csrf: null, settings: {} };
export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
export async function api(method, url, body, opts = {}) {
  const headers = { 'X-CSRF-Token': state.csrf ?? '' }; let payload = body;
  if (body && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (body instanceof Blob || body instanceof ArrayBuffer) headers['Content-Type'] = 'application/octet-stream';
  let r; try { r = await fetch('/api/v1' + url, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError('Der Hub ist gerade nicht erreichbar. Bitte prüfe die Verbindung und versuche es noch einmal.', 0); }
  const ct = r.headers.get('content-type') ?? ''; const data = ct.includes('json') ? await r.json().catch(() => null) : opts.raw ? r : await r.text();
  if (!r.ok) { if (r.status === 401 && data?.code === 'login') { state.user = null; location.hash = '#/login'; } throw new ApiError(data?.error ?? 'Das hat nicht geklappt. Bitte versuche es noch einmal.', r.status, data); }
  return opts.raw ? r : data;
}
export const get = (u) => api('GET', u), post = (u, b) => api('POST', u, b ?? {}), put = (u, b) => api('PUT', u, b), patch = (u, b) => api('PATCH', u, b), del = (u) => api('DELETE', u);
export const can = (perm) => ({ admin: 1, editor: /^(devices\.read|media\.|playlists\.|schedules\.|system\.read)/.test(perm), viewer: /^(devices|media|playlists|schedules)\.read$/.test(perm) })[state.user?.role];
