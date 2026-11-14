// Round 5 (pre-pilot): STOCK MUST NEVER LOSE A CHANGE WHEN TWO PHONES WORK AT ONCE — the phone's side.
// Every change of a lot's qty is written as a movement in the same save; the phone sends movements (never a total) and
// takes the server's true qty back, plus its own movements not yet counted there. Written before the fix.
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { ChangeSet, db, RoxDB, setSession, undoBatch } from '../src/core/db';
import { countLot } from '../src/core/billing';
import type { Batch } from '../src/core/types';

const store = new Map<string, string>();
beforeAll(() => {
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  if (!(globalThis as { window?: unknown }).window) Object.assign(globalThis, { window: new EventTarget() });
});
const settings = { firmName: 'X', gstin: '', address: '', stateCode: '33', phone: '9800000001', serverUrl: 'http://server.test', modules: { sales: true, bill: true, inventory: true, delivery: true, collection: true, accountant: true, gst: true, payroll: true }, billFormat: 'A5', returnApprovalLimit: 2000, discountAlertPct: 5 };
type Sent = { cursor: number; moves?: number; changes: { table: string; id: string; updatedAt: string; data: Record<string, unknown> }[] };
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const keys = (b: Sent) => b.changes.map(c => `${c.table}|${c.id}`);
const sum = async (lot: string) => (await db.stockMoves.where('batchId').equals(lot).toArray()).reduce((a, m) => a + m.delta, 0);

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()));
  store.clear(); store.set('dbrox.token', 'tok');
  setSession('t1', 'o1');
  const cs = new ChangeSet(); cs.put('settings', settings); await cs.commit('setup');
});
afterEach(() => { vi.unstubAllGlobals(); });

async function newLot(qty: number) {
  const cs = new ChangeSet(); const b = cs.put<Batch>('batches', { productId: 'p1', batch: 'B1', expiry: '2099-12-31', mrp: 50, qty, godown: 'Main' } as Batch, 'stock in');
  await cs.commit('Stock in'); return b;
}

describe('every change of a lot is a movement, in the same save', () => {
  it('a new lot, a bill, a count: one movement each, and qty = the sum of movements', async () => {
    const b = await newLot(100);
    expect((await db.stockMoves.toArray()).map(m => m.delta)).toEqual([100]);
    const cs = new ChangeSet(); cs.put('batches', { ...(await db.batches.get(b.id))!, qty: 90 }, 'stock out'); cs.put('invoices', { number: 'X/1', lines: [], total: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, deliveryStatus: 'pending' }, 'bill made');
    await cs.commit('Billed');
    const out = (await db.stockMoves.toArray()).find(m => m.delta === -10)!;
    expect(out.src).toMatch(/^invoices:/); expect(out.reason).toMatch(/stock out/); expect(out.by).toBe('o1');
    const c2 = new ChangeSet(); countLot(c2, (await db.batches.get(b.id))!, 87, 'counted'); await c2.commit('Count');
    expect(await sum(b.id)).toBe(87);
    expect((await db.batches.get(b.id))!.qty).toBe(87);
    // a change that is not the qty (MRP, expiry) makes no movement
    const c3 = new ChangeSet(); c3.put('batches', { ...(await db.batches.get(b.id))!, mrp: 55 }, 'mrp'); await c3.commit('MRP');
    expect(await db.stockMoves.count()).toBe(3);
  });

  it('two NEW bills in one save sharing a lot: one movement for both (its id names the last bill), never counted twice', async () => {
    const b = await newLot(100);
    const bill = (n: string, q: number) => ({ number: n, lines: [{ productId: 'p1', qty: q, freeQty: 0, batches: [{ batchId: b.id, batch: 'B1', qty: q, expiry: '2099-12-31' }] }], total: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, deliveryStatus: 'pending' });
    const cs = new ChangeSet();
    cs.put('batches', { ...b, qty: 97 }, 'stock out'); cs.put('invoices', bill('X/1', 3), 'bill made');
    cs.put('batches', { ...b, qty: 93 }, 'stock out'); const second = cs.put('invoices', bill('X/2', 4), 'bill made');
    await cs.commit('Billed two');
    const out = (await db.stockMoves.where('batchId').equals(b.id).toArray()).filter(m => m.delta < 0);
    expect(out.map(m => [m.id, m.delta])).toEqual([[`mv:${second.id}:${b.id}`, -7]]);
    expect(await sum(b.id)).toBe(93); expect((await db.batches.get(b.id))!.qty).toBe(93);
    // the same save tapped again (bills already there, lot unchanged): no second movement
    const again = new ChangeSet(); again.put('batches', { ...(await db.batches.get(b.id))! }, 'stock out'); again.put('invoices', { ...(await db.invoices.get(second.id))! }, 'bill made');
    await again.commit('Billed two');
    expect(await sum(b.id)).toBe(93);
  });

  it('a lot changed twice in one save: one movement for the whole change', async () => {
    const b = await newLot(50);
    const cs = new ChangeSet(); cs.put('batches', { ...b, qty: 45 }, 'a'); cs.put('batches', { ...b, qty: 41 }, 'b'); await cs.commit('Two');
    expect((await db.stockMoves.toArray()).map(m => m.delta).sort()).toEqual([-9, 50]);
  });

  it('undo takes the movements back with the stock (nothing was sent)', async () => {
    const b = await newLot(20);
    const cs = new ChangeSet(); cs.put('batches', { ...b, qty: 15 }, 'stock out'); const id = await cs.commit('Billed');
    expect(await undoBatch(id)).toBeGreaterThan(0);
    expect((await db.batches.get(b.id))!.qty).toBe(20);
    expect(await sum(b.id)).toBe(20);
  });

  it('a movement is never changed (add-only), and is a whole non-zero number', async () => {
    const b = await newLot(5);
    const m = (await db.stockMoves.toArray())[0];
    const cs = new ChangeSet(); cs.put('stockMoves', { ...m, delta: 500 }); await expect(cs.commit('forge')).rejects.toThrow(/never changed/);
    const c2 = new ChangeSet(); c2.put('stockMoves', { batchId: b.id, delta: 0.5, reason: 'x', by: 'o1', at: '' }); await expect(c2.commit('bad')).rejects.toThrow(/whole number/);
  });
});

describe('sync: movements go, the true qty comes back', () => {
  it('sends movements (moves: 1); the lot takes the server qty + this phone\'s movements not yet counted there', async () => {
    const b = await newLot(100);
    { const cs = new ChangeSet(); cs.put('batches', { ...(await db.batches.get(b.id))!, qty: 80 }, 'stock out'); await cs.commit('Billed'); }
    let sent: Sent | null = null;
    vi.stubGlobal('fetch', async (u: string, init: { body: string }) => {
      if (!u.endsWith('/v1/sync')) return ok({ months: [] });
      const body = JSON.parse(init.body) as Sent; sent ??= body;
      // the office billed 10 from the same lot meanwhile: the server holds 100 − 10 − 20 = 70
      // and while this reply travels, this phone bills 5 more (made below, before the reply is read)
      if (body.changes.length) {
        const cs = new ChangeSet(); cs.put('batches', { ...(await db.batches.get(b.id))!, qty: 75 }, 'stock out'); await cs.commit('Billed again');
      }
      return ok({ cursor: 9, changes: [], accepted: keys(body), rejected: [],
        current: [{ table: 'batches', id: b.id, updatedAt: '2026-11-11T00:00:00.000Z', data: { ...(await db.batches.get(b.id))!, qty: 70, dirty: undefined } }] });
    });
    const { syncNow } = await import('../src/core/sync');
    await syncNow();
    expect(sent!.moves).toBe(1);
    expect(sent!.changes.filter(c => c.table === 'stockMoves').map(c => c.data.delta).sort()).toEqual([-20, 100]);
    // 70 on the server + the −5 not sent yet
    expect((await db.batches.get(b.id))!.qty).toBe(65);
  });

  it('a refused movement (it would take the lot below zero) is held and not counted: the phone shows the server qty', async () => {
    const b = await newLot(10);
    vi.stubGlobal('fetch', async (u: string, init: { body: string }) => {
      if (!u.endsWith('/v1/sync')) return ok({ months: [] });
      const body = JSON.parse(init.body) as Sent;
      return ok({ cursor: 1, changes: [], accepted: keys(body), rejected: [], current: [{ table: 'batches', id: b.id, updatedAt: '2026-11-11T00:00:00.000Z', data: { ...b, qty: 10, dirty: undefined } }] });
    });
    const { syncNow } = await import('../src/core/sync');
    await syncNow();
    const cs = new ChangeSet(); cs.put('batches', { ...(await db.batches.get(b.id))!, qty: 2 }, 'stock out'); await cs.commit('Billed');
    vi.stubGlobal('fetch', async (u: string, init: { body: string }) => {
      if (!u.endsWith('/v1/sync')) return ok({ months: [] });
      const body = JSON.parse(init.body) as Sent;
      const mv = keys(body).filter(k => k.startsWith('stockMoves|'));
      // another phone took 7: only 3 left, the −8 does not fit
      return ok({ cursor: 2, changes: [], accepted: keys(body).filter(k => !mv.includes(k)), rejected: mv, current: [{ table: 'batches', id: b.id, updatedAt: '2026-11-11T00:00:00.000Z', data: { ...b, qty: 3, dirty: undefined } }] });
    });
    const msg = await syncNow();
    expect(msg).toMatch(/1 held/);
    expect((await db.batches.get(b.id))!.qty).toBe(3);
    expect((await db.stockMoves.toArray()).filter(m => m.delta === -8 && m.dirty === 1)).toHaveLength(1); // kept unsent and tried again, never dropped
  });
});

describe('a phone updating to this version', () => {
  it('lots changed and not yet sent go once as a whole lot (legacyQty); every lot gets its opening movement', async () => {
    const name = 'upgrade-test-' + Date.now();
    const old = new Dexie(name);
    old.version(9).stores({ batches: 'id, tenantId, updatedAt, dirty, productId, expiry' });
    await old.open();
    await old.table('batches').bulkPut([
      { id: 'L1', tenantId: 't1', productId: 'p1', batch: 'A', expiry: '2099-12-31', mrp: 1, qty: 30, godown: 'Main', createdAt: '', updatedAt: '2026-11-01T00:00:00.000Z', dirty: 1 },
      { id: 'L2', tenantId: 't1', productId: 'p1', batch: 'B', expiry: '2099-12-31', mrp: 1, qty: 12, godown: 'Main', createdAt: '', updatedAt: '2026-11-01T00:00:00.000Z', dirty: 0 },
    ]);
    old.close();
    const now = new RoxDB(name); await now.open();
    expect((await now.batches.get('L1'))!.legacyQty).toBe(true);
    expect((await now.batches.get('L2'))!.legacyQty).toBeUndefined();
    expect((await now.stockMoves.toArray()).map(m => [m.id, m.delta, m.dirty])).toEqual([['open:L1', 30, 0], ['open:L2', 12, 0]]);
    now.close();
  });

  it('a lot still to be sent whole makes no movement and keeps its mark until the server has it', async () => {
    await db.batches.put({ id: 'W', tenantId: 't1', productId: 'p1', batch: 'W', expiry: '2099-12-31', mrp: 1, qty: 30, godown: 'Main', createdAt: '', updatedAt: '2026-11-01T00:00:00.000Z', dirty: 1, legacyQty: true } as Batch);
    const cs = new ChangeSet(); cs.put('batches', { ...(await db.batches.get('W'))!, qty: 25 }, 'stock out'); await cs.commit('Billed');
    expect(await db.stockMoves.where('batchId').equals('W').count()).toBe(0);
    expect((await db.batches.get('W'))!.legacyQty).toBe(true);
  });
});
