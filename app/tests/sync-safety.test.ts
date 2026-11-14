// Pre-pilot safety round 1 (11 Nov 2026), the phone's side. Each test failed before its fix.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { ChangeSet, db, setSession, undoBatch } from '../src/core/db';

const store = new Map<string, string>();
beforeAll(() => {
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  if (!(globalThis as { window?: unknown }).window) Object.assign(globalThis, { window: new EventTarget() });
});
const settings = { firmName: 'X', gstin: '', address: '', stateCode: '33', phone: '9800000001', serverUrl: 'http://server.test', modules: { sales: true, bill: true, inventory: true, delivery: true, collection: true, accountant: true, gst: true, payroll: true }, billFormat: 'A5', returnApprovalLimit: 2000, discountAlertPct: 5 };
type Sent = { cursor: number; changes: { table: string; id: string; updatedAt: string; data: Record<string, unknown> }[] };
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const keys = (b: Sent) => b.changes.map(c => `${c.table}|${c.id}`);

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()));
  store.clear(); store.set('dbrox.token', 'old-token');
  setSession('t1', 'o1');
  const cs = new ChangeSet(); cs.put('settings', settings); await cs.commit('setup');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('sync replies the phone must act on', () => {
  it('keeps the renewed token the server sends back', async () => {
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => ok({ cursor: 1, changes: [], accepted: keys(JSON.parse(init.body)), rejected: [], current: [], token: 'renewed-token' }));
    const { syncNow } = await import('../src/core/sync');
    await syncNow();
    // kept in the phone's secure store, never in localStorage (security standard, 13 Nov 2026)
    const { getToken } = await import('../src/core/secure');
    expect(await getToken()).toBe('renewed-token');
    expect(store.has('dbrox.token')).toBe(false);
  });

  it('a refused NEW record is never marked sent (held, tried again); a refused existing one takes the server copy', async () => {
    const cs = new ChangeSet();
    const fresh = cs.put('orders', { shopId: 's1', lines: [], status: 'new', date: '2026-11-11', issues: [], invoiceIds: [] });
    const known = cs.put('shops', { name: 'Mine', creditLimit: 99999 });
    await cs.commit('offline work');
    let calls = 0;
    vi.stubGlobal('fetch', async (u: string, init: { body: string }) => {
      if (!u.endsWith('/v1/sync')) return ok({}, 404); // the archive fetch of a new phone is not a sync
      calls++;
      const b = JSON.parse(init.body) as Sent;
      const mine = (k: string) => k.endsWith(fresh.id) || k.endsWith(known.id);
      return ok({ cursor: 2, changes: [], accepted: keys(b).filter(k => !mine(k)), rejected: keys(b).filter(mine),
        current: b.changes.filter(c => c.id === known.id).map(c => ({ ...c, updatedAt: '2026-11-10T00:00:00.000Z', data: { ...c.data, creditLimit: 0 } })) });
    });
    const { syncNow } = await import('../src/core/sync');
    const msg = await syncNow();
    expect((await db.orders.get(fresh.id))?.dirty).toBe(1);      // still unsent
    expect(msg).toMatch(/1 held/);
    const shop = await db.shops.get(known.id);
    expect(shop?.dirty).toBe(0); expect(shop?.creditLimit).toBe(0); // corrected to the server's copy
    expect(calls).toBe(1); // a held record does not loop the sync
  });

  it('the server\'s reason for a refusal reaches the person (Part 2 batch 1: "a company order has each product once")', async () => {
    const cs = new ChangeSet();
    const fresh = cs.put('orders', { shopId: 's1', lines: [], status: 'new', date: '2026-11-11', issues: [], invoiceIds: [] });
    await cs.commit('offline work');
    vi.stubGlobal('fetch', async (u: string, init: { body: string }) => {
      if (!u.endsWith('/v1/sync')) return ok({}, 404);
      const b = JSON.parse(init.body) as Sent;
      const k = `orders|${fresh.id}`;
      return ok({ cursor: 2, changes: [], accepted: keys(b).filter(x => x !== k), rejected: [k], current: [], reasons: { [k]: 'a company order has each product once' } });
    });
    const { syncNow } = await import('../src/core/sync');
    expect(await syncNow()).toMatch(/1 held: not accepted by the server \(a company order has each product once\)/);
  });

  it('pushes at most ~2 MB per request (photos), in batches, until everything is sent', async () => {
    const photo = 'data:image/jpeg;base64,' + 'A'.repeat(200 * 1024);
    const cs = new ChangeSet({ noAudit: true });
    for (let i = 0; i < 30; i++) cs.put('shops', { name: `Shop ${i}`, photo });
    await cs.commit('import');
    const sizes: number[] = []; let sent = 0;
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      sizes.push(init.body.length);
      const b = JSON.parse(init.body) as Sent; sent += b.changes.filter(c => c.table === 'shops').length;
      return ok({ cursor: 3, changes: [], accepted: keys(b), rejected: [], current: [] });
    });
    const { syncNow } = await import('../src/core/sync');
    await syncNow();
    expect(sent).toBe(30);
    expect(Math.max(...sizes)).toBeLessThan(2.3 * 1024 * 1024);
    expect(await db.shops.where('dirty').equals(1).count()).toBe(0);
  });

  // the tester, 13 Nov 2026: "Access removed" wiped the phone even with unsent work (bills, payments, stock lost)
  it('"Access removed" with unsent work: nothing is wiped, the login is cleared and the phone waits for the owner or office', async () => {
    const cs = new ChangeSet(); cs.put('shops', { name: 'Unsent' }); await cs.commit('x');
    let logouts = 0; window.addEventListener('dbrox:logout', () => logouts++);
    vi.stubGlobal('fetch', async () => ok({ error: 'Please log in again' }, 401));
    const { syncNow, accessRemovedState } = await import('../src/core/sync');
    await syncNow();
    expect(await db.shops.count()).toBe(1);
    vi.stubGlobal('fetch', async () => ok({ error: 'Access removed' }, 403));
    const msg = await syncNow();
    expect(msg).toMatch(/Access removed\. This phone has \d+ unsent records? — the owner or office must log in here to send them\./);
    expect(await db.shops.count()).toBe(1); // kept
    expect((await accessRemovedState())!.unsent).toBeGreaterThan(0);
    const { getToken } = await import('../src/core/secure');
    expect(await getToken()).toBe('');
    expect(logouts).toBe(2);
  });

  // the tester on 08aa1b4: "nothing unsent?" and the wipe were two steps — a record saved in between was wiped
  it('a record saved while the phone is being wiped is never lost (the check and the wipe are one step)', async () => {
    const { finishRemovedPhone } = await import('../src/core/sync');
    for (const t of db.tables) if (t.schema.indexes.some(i => i.name === 'dirty')) await t.toCollection().modify({ dirty: 0 });
    await db.meta.put({ key: 'accessRemoved', value: { unsent: 0 } });
    const cs = new ChangeSet(); const late = cs.put('shops', { name: 'Saved during the wipe' });
    const [wiped] = await Promise.all([finishRemovedPhone(), cs.commit('late save')]);
    const kept = await db.shops.get(late.id);
    expect(wiped ? !!kept : !!kept).toBe(true); // whichever came first, the late record is still on the phone
    const { wipeLocal } = await import('../src/core/sync');
    expect(await wipeLocal()).toBe(false); // it is unsent: no wipe
    expect(await db.shops.get(late.id)).toBeTruthy();
    expect(await db.settings.count()).toBeGreaterThan(0);
  });

  // security review of Part 1 (14 Nov 2026): personal TESRAX chats and My files never stay behind on a removed phone
  it('removal / 30-day wipe with unsent firm work: the firm data stays, but every person\'s chats and My files go', async () => {
    const cs = new ChangeSet(); cs.put('shops', { name: 'Unsent shop' }); await cs.commit('unsent');
    for (const k of ['chat:o1:2026-11-14', 'chat:u2:2026-11-13', 'myfiles:o1', 'myfiles:u2']) await db.meta.put({ key: k, value: [] });
    await db.meta.put({ key: 'cursor', value: 3 });
    const { wipeLocal } = await import('../src/core/sync');
    expect(await wipeLocal()).toBe(false);
    expect(await db.shops.count()).toBeGreaterThan(0);
    expect((await db.meta.toArray()).map(r => r.key).filter(k => /^(chat|myfiles):/.test(k))).toEqual([]);
    expect(await db.meta.get('cursor')).toBeTruthy();
  });

  it('the message never says "0 unsent records"', async () => {
    const { accessRemovedMsg } = await import('../src/core/sync');
    expect(accessRemovedMsg(0)).toBe('Access removed.');
    expect(accessRemovedMsg(2)).toMatch(/2 unsent records/);
  });

  it('"Access removed" with nothing unsent: the phone wipes its local data as before', async () => {
    for (const t of db.tables) if (t.schema.indexes.some(i => i.name === 'dirty')) await t.toCollection().modify({ dirty: 0 });
    await db.meta.delete('accessRemoved');
    vi.stubGlobal('fetch', async () => ok({ error: 'Access removed' }, 403));
    const { syncNow } = await import('../src/core/sync');
    await syncNow();
    expect(await db.shops.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
  });
});

describe('credit-note numbers with a server: never the phone counter', () => {
  it('offline: saved "number pending"; numbered from the server at the next sync, then sent', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    const { creditNoteNumbers } = await import('../src/core/billing');
    const cs = new ChangeSet();
    const [no] = await creditNoteNumbers(cs, 1);
    expect(no).toMatch(/PENDING/);
    const cn = cs.put('creditNotes', { number: no, invoiceId: 'i1', shopId: 's1', companyId: 'c1', date: '2026-11-11', reason: 'Return', lines: [], total: 10 });
    await cs.commit('return');
    expect((await db.settings.toCollection().first())?.nextCnNo).toBeUndefined(); // no phone counter
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    const pushed: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      if (url.endsWith('/v1/number')) return ok({ first: 41, count: 1, prefix: 'DBX' });
      const b = JSON.parse(init.body) as Sent;
      pushed.push(...b.changes.filter(c => c.table === 'creditNotes').map(c => String(c.data.number)));
      return ok({ cursor: 4, changes: [], accepted: keys(b), rejected: [], current: [] });
    });
    const { syncNow } = await import('../src/core/sync');
    await syncNow();
    const { finYear } = await import('../src/core/billing');
    const fy = finYear('2026-11-11');
    expect((await db.creditNotes.get(cn.id))?.number).toBe(`CN/${fy}/00041`);
    expect(pushed).toEqual([`CN/${fy}/00041`]); // the pending one was never sent
  });
});

describe('TESRAX report and photos', () => {
  it('a day count is per phone (staffId|day|device), and a miss is cut by whole characters', async () => {
    const { noteMessage } = await import('../src/core/tesraxReport');
    const said = 'a'.repeat(119) + '😀 more';
    await noteMessage('owner', said, { text: 'x', missed: true }, 5);
    const d = (await db.tesraxDays.toArray())[0];
    expect(d.id).toMatch(/^o1\|\d{4}-\d{2}-\d{2}\|.+/);
    expect(d.misses[0]).toBe('a'.repeat(119) + '😀');
  });

  it('the report adds up the same person\'s counts from two phones', async () => {
    const { tesraxReport } = await import('../src/core/tesraxReport');
    const row = (dev: string, n: number) => ({ id: `o1|2026-11-11|${dev}`, day: '2026-11-11', staffId: 'o1', role: 'owner', n, done: n, answer: 0, ask: 0, missed: 0, refused: 0, msTotal: 10 * n, msMax: 10, approved: 0, edited: 0, cancelled: 0, misses: [] });
    const cs = new ChangeSet({ noAudit: true }); cs.put('tesraxDays', row('a', 3)); cs.put('tesraxDays', row('b', 2)); await cs.commit('x');
    const r = await tesraxReport('2026-11-11');
    expect(r.messages).toBe(5);
    expect(r.staff).toEqual([{ staffId: 'o1', role: 'owner', messages: 5, understood: 100, avgMs: 10 }]);
  });

  it('the history log keeps no photo copies, and undo still puts the photo back', async () => {
    const photo = 'data:image/jpeg;base64,' + 'B'.repeat(50000);
    const cs = new ChangeSet(); const s = cs.put('shops', { name: 'Photo shop', photo }); await cs.commit('add');
    const cs2 = new ChangeSet(); cs2.put('shops', { ...(await db.shops.get(s.id))!, name: 'Renamed' }); const batch = await cs2.commit('rename');
    const log = await db.audit.where('batchId').equals(batch).toArray();
    expect(JSON.stringify(log).length).toBeLessThan(5000);
    expect(await undoBatch(batch)).toBe(1);
    expect(await db.shops.get(s.id)).toMatchObject({ name: 'Photo shop', photo });
  });
});
