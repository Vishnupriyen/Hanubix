// Part 2 batch 1 fixes, group 2 (systems-engineer): purchases and company bills may list the same product on several lines
// (each its own lot). Found by the review: a company bill with two lines of 10 and 4 short stocked 12 (the product's whole
// short was taken from every line) — it must stock 16. Written before the fix.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ChangeSet, db, setSession } from '../src/core/db';
import type { Inbound, Product, Purchase } from '../src/core/types';

const store = new Map<string, string>();
beforeAll(() => {
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  if (!(globalThis as { window?: unknown }).window) Object.assign(globalThis, { window: new EventTarget() });
});
const settings = { firmName: 'X', gstin: '', address: '', stateCode: '33', phone: '9800000001', modules: { sales: true, bill: true, inventory: true, delivery: true, collection: true, accountant: true, gst: true, payroll: true }, billFormat: 'A5', returnApprovalLimit: 2000, discountAlertPct: 5 };
let P: Product;
beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()));
  setSession('t1', 'o1');
  const cs = new ChangeSet(); cs.put('settings', settings);
  P = cs.put<Product>('products', { companyId: 'c1', name: 'Tea 250g', hsn: '0902', gst: 5, mrp: 120, rate: 100, purchaseRate: 80, caseSize: 10, aliases: [], active: true } as unknown as Product);
  await cs.commit('setup');
});
const bill = async (lines: { qty: number; rate: number; batch?: string }[]) => {
  const cs = new ChangeSet();
  const inb = cs.put<Inbound>('inbound', { companyId: 'c1', number: 'KC/77', date: '2026-11-10', taxable: 0, tax: 0, total: 0,
    lines: lines.map(l => ({ productId: P.id, coProductId: 'co-' + P.id, name: P.name, hsn: '0902', qty: l.qty, freeQty: 0, rate: l.rate, gst: 5, taxable: l.qty * l.rate, batch: l.batch, expiry: '2027-06-30', mrp: 120 })) } as unknown as Inbound);
  await cs.commit('bill arrived'); return inb;
};
const stock = async () => (await db.batches.where('productId').equals(P.id).toArray()).reduce((a, b) => a + b.qty, 0);

describe('a company bill with the same product on two lines', () => {
  it('two lines of 10 with 4 short stocks 16 (the short is taken once, from the lines in order)', async () => {
    const inb = await bill([{ qty: 10, rate: 80 }, { qty: 10, rate: 78 }]);
    const { receiveInbound } = await import('../src/core/grn');
    await receiveInbound(inb.id, [{ productId: P.id, qty: 4 }], []);
    expect(await stock()).toBe(16);
    const lots = await db.batches.where('productId').equals(P.id).toArray();
    expect(lots.map(l => [l.batch, l.qty]).sort()).toEqual([['KC/77', 10], ['KC/77', 6]]); // blank batch → bill number, two lots
    const claim = (await db.claimEntries.toArray())[0];
    expect(claim.qty).toBe(4); expect(claim.amount).toBe(336); // 4 × ₹80 + 5% (line 1's rate)
  });
  it('a difference for one line is checked against that line (and the product total against all its lines)', async () => {
    const inb = await bill([{ qty: 10, rate: 80 }, { qty: 6, rate: 80 }]);
    const { receiveInbound } = await import('../src/core/grn');
    await expect(receiveInbound(inb.id, [{ productId: P.id, qty: 7, line: 2 }], [])).rejects.toThrow(/more short or damaged than the bill has/);
    await expect(receiveInbound(inb.id, [{ productId: P.id, qty: 17 }], [])).rejects.toThrow(/more short or damaged than the bill has/);
    await receiveInbound(inb.id, [{ productId: P.id, qty: 12 }], [{ productId: P.id, qty: 1, line: 2 }]);
    expect(await stock()).toBe(3); // 16 − 12 short − 1 damaged
  });
  it('each line\'s lot costs its own rate in the P&L (two lots of one batch never mix their cost)', async () => {
    const inb = await bill([{ qty: 10, rate: 80 }, { qty: 10, rate: 60 }]);
    const { receiveInbound } = await import('../src/core/grn');
    await receiveInbound(inb.id, [], []);
    const pu = (await db.purchases.toArray())[0] as Purchase;
    const lots = await db.batches.where('productId').equals(P.id).toArray();
    expect(pu.lines.map(l => [l.rate, lots.find(b => b.id === l.batchId)?.qty])).toEqual([[80, 10], [60, 10]]);
    const { lotCostRates } = await import('../src/core/pnl');
    const rates = await lotCostRates();
    expect(pu.lines.map(l => rates.byLot.get(l.batchId!))).toEqual([80, 60]);
  });
});

describe('a typed purchase bill', () => {
  it('the same product twice is fine (different batch or rate); only a true double entry is refused', async () => {
    const { validate } = await import('../src/core/proposals');
    const row = (x: Record<string, unknown>) => ({ productId: P.id, item: 'Tea', qty: 10, free: 0, rate: 80, discount: 0, gst: 5, mrp: 120, batch: 'B1', expiry: '2027-06-30', amount: 0, ...x });
    const prop = (rows: Record<string, unknown>[]) => ({ kind: 'purchase', fields: [{ key: 'companyId', value: 'c1' }, { key: 'billNo', value: 'P-1' }], rows, meta: {} });
    const ok = await validate(prop([row({}), row({ batch: 'B2' }), row({ rate: 0.01 * 7000 })]) as never);
    expect(JSON.stringify(ok.errors)).not.toMatch(/listed twice/);
    const dup = await validate(prop([row({}), row({ qty: 5 })]) as never);
    expect(JSON.stringify(dup.errors)).toMatch(/This product is listed twice with the same batch and expiry. Check the bill./);
  });
});
