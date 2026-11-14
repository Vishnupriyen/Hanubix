// Our own sync layer (scale plan): phone ⇄ Hanubix server. Phones work offline; this runs when
// there is signal. Server is swappable because the app only knows this small protocol.
import { saveLicence } from './licence';
import { ChangeSet, db, getSettings } from './db';
import { purgePersonal } from './myfiles';
import { authHeader, checkPinOffline, clearToken, getToken, offlineState, OFFLINE_LOGIN_DAYS, rememberPin, securePins, setToken, touchServer } from './secure';
import privacy from '../../../shared/privacy.json';
import type { Base, TableName } from './types';

import shared from '../../../shared/tables.json';
// Phone and server load the same shared/tables.json, so a table can never exist on one side only.
const SYNC_TABLES = shared.tables as TableName[];
const KNOWN = new Set<string>(SYNC_TABLES);

interface Change { table: string; id: string; updatedAt: string; data: Base }

// Server address: set at build time (VITE_SERVER_URL) for real distributors, or typed in Settings.
export const ENV_SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') || '';
export async function server(): Promise<string | null> {
  if (ENV_SERVER) return ENV_SERVER;
  try { return (await getSettings()).serverUrl?.replace(/\/$/, '') || null; } catch { return null; }
}

/** the privacy notice version the person ticked (shared/privacy.json; the server checks the same one) */
export const PRIVACY_VERSION = privacy.version;
export async function signup(body: { firmName: string; ownerName: string; phone: string; pin: string; gstin?: string; address?: string; kind?: 'company'; consent: { version: string; optional?: Record<string, boolean> } }) {
  const url = await server();
  if (!url) throw new Error('No server');
  const r = await fetch(`${url}/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Sign-up failed');
  await setToken(j.token);
  await rememberPin(j.tenantId, j.userId, body.phone, body.pin);
  await touchServer();
  await saveLicence(j.licence);
  return { tenantId: j.tenantId as string, userId: j.userId as string };
}

export type LoginResult = { tenantId: string; userId: string; mustChangePin?: boolean; pinLength?: number } | { choose: { tenantId: string; firm: string }[] } | { error: string } | null;
export async function login(phone: string, pin: string, tenantId?: string): Promise<LoginResult> {
  const url = await server();
  if (url && navigator.onLine) {
    try {
      const r = await fetch(`${url}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, pin, tenantId }) });
      if (r.ok) {
        const j = await r.json();
        if (j.choose) return { choose: j.choose }; // same phone under two distributors → the app asks which firm
        // a phone whose person was removed with unsent work: only the same firm's owner or office may log in (a brand's
        // head office for a company phone); with nothing left unsent the wipe is finished first
        let removed = await accessRemovedState();
        if (removed && !removed.unsent && await wipeLocal()) removed = null;
        if (removed && !(j.tenantId === removed.tenantId && (removed.kind === 'company' ? ['cadmin'] : ['owner', 'office']).includes(String(j.role)))) return { error: accessRemovedMsg(removed.unsent) };
        await setToken(j.token);
        await rememberPin(j.tenantId, j.userId, phone, pin); // a salted hash only: the offline login and the app lock
        await touchServer();
        await saveLicence(j.licence);
        // the owner's forced 6-digit PIN: kept on the phone until done, so closing the app never skips it
        if (j.mustChangePin) await db.meta.put({ key: mustKey(j.tenantId, j.userId), value: Number(j.pinLength ?? 6) });
        else await db.meta.delete(mustKey(j.tenantId, j.userId));
        return { tenantId: j.tenantId, userId: j.userId, ...(j.mustChangePin ? { mustChangePin: true, pinLength: Number(j.pinLength ?? 6) } : {}) };
      }
      if (r.status === 401) return null;
      if (r.status === 429) return { error: (await r.json().catch(() => ({}))).error ?? 'Too many wrong PINs. Try again in a few minutes.' };
    } catch { /* offline: fall back to the PIN check on this phone */ }
  }
  // offline: only a phone that reached the server in the last 14 days; the PIN checked against its hash on this phone
  const removed = await accessRemovedState();
  if (removed) return { error: removed.unsent ? `${accessRemovedMsg(removed.unsent)} Connect to the internet.` : accessRemovedMsg(0) };
  const off = await offlineState(!!url);
  if (off.mustLogin) return { error: `This phone has not reached the server for ${off.days} days. Connect to the internet to log in.` };
  await securePins(!!url);
  const c = await checkPinOffline(phone, pin, tenantId);
  if (!c.ok) return c.why === 'locked' ? { error: `Too many wrong PINs. Try again after ${new Date(c.until!).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.` } : null;
  const s = await db.staff.get(c.userId);
  if (!s || !s.active) return null;
  return { tenantId: c.tenantId, userId: c.userId };
}

const mustKey = (tenantId: string, userId: string) => `mustPin:${tenantId}|${userId}`;
/** a PIN change the server asked for and not yet done on this phone: the PIN length to choose, or null */
export async function pinChangeDue(tenantId: string, userId: string): Promise<number | null> {
  const v = (await db.meta.get(mustKey(tenantId, userId)))?.value;
  return typeof v === 'number' ? v : null;
}

/** records on this phone not yet sent to the server */
export async function unsentCount(): Promise<number> {
  let n = 0;
  for (const t of SYNC_TABLES) n += await db.table(t).where('dirty').equals(1).count();
  return n;
}
export async function hasUnsent(): Promise<boolean> { return (await unsentCount()) > 0; }
export const accessRemovedMsg = (n: number) => n > 0 ? `Access removed. This phone has ${n} unsent record${n === 1 ? '' : 's'} — the owner or office must log in here to send them.` : 'Access removed.';
/** a phone whose person was removed while it held unsent work: waiting for the owner or office (null when not) */
export async function accessRemovedState(): Promise<{ unsent: number; tenantId: string; kind: string } | null> {
  const v = (await db.meta.get('accessRemoved'))?.value as { tenantId?: string; kind?: string } | undefined;
  return v ? { unsent: await unsentCount(), tenantId: String(v.tenantId ?? ''), kind: String(v.kind ?? 'distributor') } : null;
}
/** after the owner or office logged in and synced on such a phone: once nothing is unsent, the phone's copy is removed
 *  (the check and the wipe are one step: wipeLocal) */
export async function finishRemovedPhone(): Promise<boolean> {
  if (!(await db.meta.get('accessRemoved'))) return false;
  return wipeLocal();
}
/**
 * At start: a phone away from the server for 14 days must log in online; at 30 days its copy of the firm's data is
 * removed — but NEVER while it holds unsent work (a sync is tried first; if work is still unsent, everything is kept and
 * only an online login is asked for, and that login sends the work at once).
 */
export async function offlineCheck(): Promise<{ wiped: boolean; mustLogin: boolean; kept: boolean; days: number; warnDaysLeft: number | null }> {
  const url = await server();
  let off = await offlineState(!!url);
  if (off.mustLogin && navigator.onLine) { try { await syncNow(); } catch { /* still offline */ } off = await offlineState(!!url); }
  if (!off.mustLogin) return { wiped: false, mustLogin: false, kept: false, days: off.days, warnDaysLeft: off.warnDaysLeft };
  if (off.wipe && await wipeLocal()) return { wiped: true, mustLogin: true, kept: false, days: off.days, warnDaysLeft: null };
  return { wiped: false, mustLogin: true, kept: await hasUnsent(), days: off.days, warnDaysLeft: null };
}

/** the demo (no server): tapping a name signs in at once — there is nothing to protect and no PIN to show */
export async function demoLogin(staffId: string): Promise<{ tenantId: string; userId: string } | null> {
  if (await server()) return null;
  const s = await db.staff.get(staffId);
  return s?.active ? { tenantId: s.tenantId, userId: s.id } : null;
}

/** a call to the server with this phone's login (privacy, PIN change, phone lock …) */
export async function api<T = Record<string, unknown>>(path: string, body: object = {}): Promise<T> {
  const url = await server();
  if (!url) throw Object.assign(new Error('This needs the Hanubix server. In the demo, nothing leaves this phone.'), { name: 'GuardError' });
  if (!navigator.onLine) throw Object.assign(new Error('No internet. Try again when there is signal.'), { name: 'GuardError' });
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `Not done (${r.status})`), { name: 'GuardError' });
  await touchServer();
  return j as T;
}
/** change my own PIN (the owner and head office: 6 digits). The other phones with this login log in again. */
export async function changePin(tenantId: string, userId: string, phone: string, old: string, pin: string) {
  const j = await api<{ token: string }>('/v1/pin/change', { old, pin });
  await setToken(j.token);
  await rememberPin(tenantId, userId, phone, pin);
  await db.meta.delete(mustKey(tenantId, userId));
}
export const OFFLINE_DAYS = OFFLINE_LOGIN_DAYS;

// Bill / credit-note / receipt numbers come from the server (one series per distributor, never a duplicate).
// Without a server (demo), the phone keeps its own series.
export async function nextNumbers(kind: 'bill' | 'cn' | 'receipt', count = 1): Promise<{ first: number; prefix: string } | null> {
  const url = await server();
  if (!url) return null;
  if (!navigator.onLine) throw new Error('offline');
  const r = await fetch(`${url}/v1/number`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ kind, count }) });
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error ?? 'Could not get a bill number'), { name: r.status === 402 || r.status === 403 ? 'GuardError' : 'Error' });
  return await r.json();
}

/** PINs anyone would try first — the same list as the server (server/src/rules.ts weakPin): one digit repeated, pairs
 *  repeated, straight or step-2 runs (1234, 1357, 2468, 9753), keypad lines (2580, 0852 …), years 1950–2030, and for
 *  6 digits a date (DDMMYY or YYMMDD) */
export const WEAK_PIN_MSG = 'This PIN is too easy to guess (a run like 1357, a repeat, a year or a date). Choose another.';
export function weakPin(pin: string): boolean {
  if (!/^(\d{4}|\d{6})$/.test(pin)) return false;
  const d = [...pin].map(Number);
  if (new Set(d).size === 1) return true;
  if (/^(\d\d)\1+$/.test(pin) || /^(\d\d\d)\1$/.test(pin)) return true;
  for (const step of [1, 2, -1, -2]) if (d.every((x, i) => i === 0 || (x - d[i - 1] + 10) % 10 === (step + 10) % 10)) return true;
  if (['2580', '0852', '1470', '0741', '3690', '0963', '7410', '9630', '1590', '9510', '3570', '0753', '147258', '258369', '852741', '123123', '112233', '102030', '010203'].some(k => pin.includes(k) && (k.length === pin.length || pin.length === 4))) return true;
  if (pin.length === 4) { const y = Number(pin); return y >= 1950 && y <= 2030; }
  const date = (dd: number, mm: number) => mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
  return date(d[0] * 10 + d[1], d[2] * 10 + d[3]) || date(d[4] * 10 + d[5], d[2] * 10 + d[3]);
}

// a credit note made without signal waits for its number (owner decision: with a server, numbers come from it only)
export const PENDING_MARK = '/PENDING-';
export const isPendingNumber = (n: unknown) => typeof n === 'string' && n.includes(PENDING_MARK);
/** give every waiting credit note its number from the server (before it is sent). Without signal they keep waiting. */
async function numberPendingCreditNotes() {
  const cns = (await db.creditNotes.toArray()).filter(c => isPendingNumber(c.number));
  const decisions = (await db.claimDecisions.toArray()).filter(d => isPendingNumber(d.creditNoteNo));
  const n = cns.length + decisions.length;
  if (!n) return;
  let got: { first: number } | null;
  try { got = await nextNumbers('cn', Math.min(n, 20)); } catch { return; }
  if (!got) return;
  let next = got.first, left = Math.min(n, 20);
  const real = (pending: string) => `${pending.slice(0, pending.indexOf(PENDING_MARK))}/${String(next++).padStart(5, '0')}`;
  const cs = new ChangeSet();
  for (const c of cns) { if (!left--) break; cs.put('creditNotes', { ...c, number: real(c.number) }, 'credit note numbered'); }
  for (const d of decisions) { if (left-- <= 0) break; cs.put('claimDecisions', { ...d, creditNoteNo: real(String(d.creditNoteNo)) }, 'credit note numbered'); }
  await cs.commit('Credit note numbers from the server');
}

/** "Access removed" (staff removed by the owner): nothing of the firm's data stays on this phone */
export async function wipeLocal(): Promise<boolean> {
  // "nothing unsent?" and the clearing are ONE transaction over every table: a record saved meanwhile either lands
  // first (the wipe is called off) or after (it stays) — it is never cleared unsent (tester, 13 Nov 2026)
  const cleared = await db.transaction('rw', db.tables, async () => {
    for (const t of SYNC_TABLES) if (await db.table(t).where('dirty').equals(1).count()) return false;
    await Promise.all(db.tables.map(t => t.clear()));
    return true;
  });
  // chats and My files of everyone on this phone go even when unsent firm work keeps the rest (security, 14 Nov 2026)
  if (!cleared) { await purgePersonal(); return false; }
  await clearToken();
  for (const k of ['dbrox.token', 'dbrox.session']) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  return true;
}

const PUSH_BYTES = 2 * 1024 * 1024; // one request carries at most ~2 MB (photos): a big backlog goes in several
const held = new Set<string>();     // refused NEW records: kept unsent on this phone, tried again at the next "Sync now"

let running = false;
export async function syncNow(): Promise<string> {
  let msg = '';
  held.clear(); // every run tries the held ones once more (a renewed plan, a fixed record)
  // a phone starting from nothing (new phone, reinstall) also needs the records the server has moved to its archive
  // (bills older than last financial year): without them a shop's old dues and last year's reports would be missing
  if (!(await db.meta.get('archiveDone')) && Number((await db.meta.get('cursor'))?.value ?? 0) === 0) await db.meta.put({ key: 'archiveDone', value: 'pending' });
  // keep going until everything is sent and received: stopping early left a busy owner's phone showing only a third of
  // the bills after first login (the cap is only a guard against a server that never says "done")
  await catchUpNewTables();
  for (let i = 0; i < 2000; i++) {
    const r = await syncOnce();
    msg = r.msg;
    if (!r.more) break;
  }
  if ((await db.meta.get('archiveDone'))?.value === 'pending' && msg.startsWith('Synced')) await fetchArchive();
  // a staff PIN typed on this phone has reached the server: kept here as a hash only from now on
  try { await securePins(true); } catch { /* tried again at the next sync */ }
  // company reps' orders that came in: stock and credit flags, like a salesman's order (owner / office phone only)
  try { const { flagArrivedOrders } = await import('./pipeline'); await flagArrivedOrders(); } catch { /* tried again next sync */ }
  return msg;
}

/** the old records, a month at a time; each month is remembered once saved, so a cut-off download carries on later.
 *  Saved as already-synced (never sent back), and a newer copy on the phone is never replaced. */
export async function fetchArchive(): Promise<number> {
  const url = await server();
  if (!url || !navigator.onLine) return 0;
  const call = async (path: string, body: object) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(body) });
    return r.ok ? await r.json() : r.status === 404 ? 404 : null;
  };
  let saved = 0;
  try {
    const list = await call('/v1/archive/list', {});
    if (list === 404) { await db.meta.put({ key: 'archiveDone', value: 'yes' }); return 0; } // a server with no archive
    if (!list) return 0;
    const months = (Array.isArray(list.months) ? list.months : []) as { tbl: string; month: string }[];
    for (const m of months) {
      const key = `archive:${m.tbl}|${m.month}`;
      if (!SYNC_TABLES.includes(m.tbl as TableName) || await db.meta.get(key)) continue;
      const got = await call('/v1/archive/month', { tbl: m.tbl, month: m.month });
      if (!got) return saved; // tried again on the next sync
      const rows = (Array.isArray(got.changes) ? got.changes : []) as Change[];
      await db.transaction('rw', [db.table(m.tbl), db.meta], async () => {
        for (const c of rows) {
          const cur = await db.table(m.tbl).get(c.id);
          if (!cur || (!cur.dirty && cur.updatedAt < c.updatedAt)) { await db.table(m.tbl).put({ ...c.data, updatedAt: c.updatedAt, dirty: 0 }); saved++; }
        }
        await db.meta.put({ key, value: 1 });
      });
    }
    await db.meta.put({ key: 'archiveDone', value: 'yes' });
  } catch { /* no signal: carried on at the next sync */ }
  return saved;
}

/**
 * After an app update that adds a table (Business Boost added one), the phone's place in the sync is already past that table's
 * earlier records — it was not sent them while it did not know the table. So, once, it fetches just the new tables from the
 * start, with its own place kept separately; the main sync's place never moves back. A brand-new phone, or a phone moving to
 * the first version that keeps this list, already has every table it knows. A cut-off catch-up carries on at the next sync.
 */
async function catchUpNewTables() {
  const known = (await db.meta.get('knownTables'))?.value as string[] | undefined;
  if (!known) { await db.meta.put({ key: 'knownTables', value: SYNC_TABLES }); return; }
  const fresh = SYNC_TABLES.filter(t => !known.includes(t));
  if (!fresh.length) { if (known.length !== SYNC_TABLES.length) await db.meta.put({ key: 'knownTables', value: SYNC_TABLES }); return; }
  const url = await server();
  if (!url || !navigator.onLine || running) return;
  running = true;
  try {
    let from = Number((await db.meta.get('catchUpCursor'))?.value ?? 0), finished = false;
    for (let i = 0; i < 2000; i++) {
      const r = await fetch(`${url}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ cursor: from, changes: [], moves: 1, tables: fresh }) });
      if (!r.ok) return; // tried again at the next sync; the main sync reports any login problem
      const res: { cursor: number; changes: Change[]; more?: boolean } = await r.json();
      const rows = (res.changes ?? []).filter(c => fresh.includes(c.table as TableName)); // an older server sends every table: the rest already came
      await db.transaction('rw', [...fresh.map(t => db.table(t)), db.meta], async () => {
        for (const c of rows) {
          const cur = await db.table(c.table).get(c.id);
          if (!cur || (!cur.dirty && cur.updatedAt <= c.updatedAt)) await db.table(c.table).put({ ...c.data, dirty: 0 });
        }
        await db.meta.put({ key: 'catchUpCursor', value: res.cursor });
      });
      from = res.cursor;
      if (!res.more) { finished = true; break; }
    }
    if (!finished) return; // a guard against a server that never says "done": carried on at the next sync, nothing skipped
    await db.meta.put({ key: 'knownTables', value: SYNC_TABLES });
    await db.meta.delete('catchUpCursor');
  } catch { /* no signal: carried on at the next sync */ } finally { running = false; }
}

async function syncOnce(): Promise<{ msg: string; more: boolean }> {
  const done = (msg: string, more = false) => ({ msg, more });
  const url = await server();
  if (!url) return done('Not connected to a Hanubix server yet. Everything is saved safely on this phone.');
  if (!navigator.onLine) return done('Offline — will sync when there is signal.');
  if (running) return done('Sync already running.');
  running = true;
  try {
    const token = await getToken();
    const cursor = Number((await db.meta.get('cursor'))?.value ?? 0);
    await numberPendingCreditNotes();
    try { const { numberPendingReceipts } = await import('./receipts'); await numberPendingReceipts(); } catch { /* numbered at a later sync */ }
    const changes: Change[] = [];
    let bytes = 0, full = false;
    for (const t of SYNC_TABLES) {
      if (full) break;
      const dirty = await db.table(t).where('dirty').equals(1).limit(500 + held.size).toArray();
      let n = 0;
      for (const d of dirty) {
        if (held.has(`${t}|${d.id}`)) continue;
        if ((t === 'creditNotes' && isPendingNumber(d.number)) || (t === 'claimDecisions' && isPendingNumber(d.creditNoteNo))) continue; // waits for its number
        const c = { table: t, id: d.id, updatedAt: d.updatedAt, data: { ...d, dirty: undefined } };
        const size = JSON.stringify(c).length;
        if (changes.length && bytes + size > PUSH_BYTES) { full = true; break; }
        changes.push(c); bytes += size;
        if (++n >= 500) { full = true; break; }
      }
    }
    const r = await fetch(`${url}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ cursor, changes, moves: 1, tables: SYNC_TABLES }) }); // moves: this phone sends stock as movements; tables: only what this version knows
    if (r.status === 403 && (await r.clone().json().catch(() => ({}))).error === 'Access removed') {
      // unsent work belongs to the firm: never wiped. The person's login is ended; the owner or office logs in here to
      // send it, and the phone is wiped after that (finishRemovedPhone). With nothing unsent, wiped at once.
      if (await wipeLocal()) { window.dispatchEvent(new Event('dbrox:logout')); return done('Your access was removed by the owner. This phone\'s copy of the firm\'s data has been removed.'); }
      const n = await unsentCount();
      {
        const st = (await db.settings.toCollection().first()) as { tenantId?: string; kind?: string } | undefined;
        await db.meta.put({ key: 'accessRemoved', value: { unsent: n, at: Date.now(), tenantId: st?.tenantId ?? '', kind: st?.kind === 'company' ? 'company' : 'distributor' } });
        await clearToken(); localStorage.removeItem('dbrox.session');
        for (const v of await db.meta.where('key').startsWith('pinv:').toArray()) await db.meta.delete(v.key); // no offline login for anyone until the firm has its records
        window.dispatchEvent(new Event('dbrox:logout'));
        return done(accessRemovedMsg(n));
      }
    }
    if (r.status === 401 || r.status === 403) { localStorage.removeItem('dbrox.session'); window.dispatchEvent(new Event('dbrox:logout')); return done('Please log in again. Anything not yet sent stays on this phone.'); }
    if (!r.ok) return done(`Sync failed (${r.status}). Data is safe on this phone; will retry.`);
    await touchServer(); // the phone reached the server: the 14-day offline clock starts again
    const res: { cursor: number; changes: Change[]; accepted: string[]; rejected?: string[]; reasons?: Record<string, string>; current?: Change[]; more?: boolean; licence?: string; token?: string } = await r.json();
    if (res.token) await setToken(res.token); // renewed before it runs out
    await saveLicence(res.licence); // every sync renews the licence
    const accepted = new Set(res.accepted);
    const refused = new Set(res.rejected ?? []);
    const theirs = new Map((res.current ?? []).map(c => [`${c.table}|${c.id}`, c]));
    await db.transaction('rw', SYNC_TABLES.map(t => db.table(t)), async () => {
      for (const c of changes) {
        const k = `${c.table}|${c.id}`;
        const cur = await db.table(c.table).get(c.id);
        if (!cur || cur.updatedAt !== c.updatedAt) continue; // changed again meanwhile: goes in the next sync
        const server = theirs.get(k);
        // refused, or older than what the server holds: the server's copy replaces this phone's
        if (server && (refused.has(k) || accepted.has(k))) { await db.table(c.table).put({ ...server.data, updatedAt: server.updatedAt, dirty: 0 }); continue; }
        if (accepted.has(k)) { await db.table(c.table).put({ ...cur, dirty: 0 }); continue; }
        // refused and the server has no copy (a new record): never marked sent — kept unsent and shown as held
        if (refused.has(k)) held.add(k);
      }
      for (const c of res.changes) {
        if (!KNOWN.has(c.table)) continue; // a table from a newer version (an older server ignores "tables"): never stops the sync
        const cur = await db.table(c.table).get(c.id);
        if (!cur || (!cur.dirty && cur.updatedAt <= c.updatedAt)) await db.table(c.table).put({ ...c.data, dirty: 0 });
      }
      await trueStock([...(res.current ?? []), ...res.changes]);
    });
    await db.meta.put({ key: 'cursor', value: res.cursor });
    await db.meta.put({ key: 'held', value: [...held] });
    // keep going while the server has more for us, or this phone had more waiting than one request carries
    const morePush = full && accepted.size > 0;
    // the server's plain reason (when it gives one) for the records refused in this push, so the person can fix them
    const why = [...new Set(changes.map(c => res.reasons?.[`${c.table}|${c.id}`]).filter((x): x is string => !!x))];
    const whyMsg = why.length ? ` (${why.slice(0, 3).join('; ')})` : '';
    const heldMsg = held.size ? ` ${held.size} held: not accepted by the server${whyMsg}, kept on this phone.` : why.length ? ` Not accepted by the server${whyMsg}; the server's copy is back on this phone.` : '';
    return done(`Synced: sent ${accepted.size}, received ${res.changes.length}.${heldMsg}`, !!res.more || morePush);
  } catch (e) {
    return done(`Sync paused: ${(e as Error).message}. Data is safe on this phone.`);
  } finally { running = false; }
}

/**
 * STOCK: every lot the server sent takes the server's qty (the sum of all phones' movements) + this phone's own
 * movements not yet counted there (unsent, or sent and held). A refused movement (it would take the lot below zero) is
 * held — kept and tried again — and not counted, so the phone shows the server's qty. Nothing else of the lot changes,
 * and it is not marked unsent (this is the server's word, not a change). Runs inside the sync's transaction.
 */
async function trueStock(fromServer: Change[]) {
  const lots = new Map<string, Change>();
  for (const c of fromServer) if (c.table === 'batches') lots.set(c.id, c); // the pull comes after the push: the later copy wins
  if (!lots.size) return;
  const mine = new Map<string, number>();
  for (const m of await db.stockMoves.where('dirty').equals(1).toArray()) if (!held.has(`stockMoves|${m.id}`)) mine.set(m.batchId, (mine.get(m.batchId) ?? 0) + m.delta);
  for (const [id, c] of lots) {
    const cur = await db.batches.get(id);
    const q = Number((c.data as unknown as { qty: unknown }).qty);
    if (!cur || cur.legacyQty || !Number.isFinite(q)) continue; // a lot still to be sent whole keeps its own count once more
    const want = q + (mine.get(id) ?? 0);
    if (cur.qty !== want) await db.batches.put({ ...cur, qty: want });
  }
}

export function startAutoSync() {
  const tick = () => { void syncNow(); };
  window.addEventListener('online', tick);
  setInterval(tick, 30000); // target: owner sees data within 30 s when there is signal
}
