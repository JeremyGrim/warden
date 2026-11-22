// The page's only link to the server (ui.mjs): the token, the display text, and the calls. Every call goes to the
// address the page was opened at, 127.0.0.1, and nowhere else.
//
// The token comes in the address (`#t=<token>`), is read once, and stays in memory: never in the browser's storage.

let token = null;
let strings = {};
let locale = 'en';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readToken() {
  if (token === null) {
    const match = /(?:^#|[#&])t=([0-9a-f]+)/i.exec(location.hash);
    token = match ? match[1] : '';
  }
  return token;
}

async function call(method, path, params = {}, body = undefined) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const headers = { 'x-warden-token': readToken() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new ApiError(0, '');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? String(res.status));
  return data;
}

export const get = (path, params) => call('GET', path, params);
export const post = (path, params, body = {}) => call('POST', path, params, body);

export async function loadStrings() {
  const answer = await get('/api/strings');
  strings = answer?.strings ?? {};
  locale = answer?.locale === 'fr' ? 'fr' : 'en';
  document.documentElement.lang = locale;
}

export const getLocale = () => locale;

// A display text from the catalog the server gives (messages-ui.*.mjs, keys `ui.*`), its `{name}` placeholders filled.
export function t(key, vars = {}) {
  const text = strings[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

// What a failed call says to the person.
export function errorText(error) {
  if (!(error instanceof ApiError)) return String(error?.message ?? error);
  if (error.status === 0) return t('ui.error.offline');
  if (error.status === 403) return t('ui.error.token');
  return error.message;
}
