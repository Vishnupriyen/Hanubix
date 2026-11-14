// Regression tests for bugs found in the Nov 2026 review. Each one failed before its fix.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { ChangeSet, db, setSession, undoBatch, today, daysFrom, monthEnd } from '../src/core/db';
import { seedDemo } from '../src/core/seed';
import { bookOrder, approveOrder, suggestPick, pickOrder, approvePicked, settleDifference, recordDelivery } from '../src/core/pipeline';
import { creditNoteNumbers, finYear } from '../src/core/billing';
import { shopOutstanding } from '../src/core/ledger';
import type { Product, Shop } from '../src/core/types';

let shops: Shop[]; let products: Product[];
beforeAll(async () => {
  await seedDemo();
  const owner = (await db.staff.where('role').equals('owner').first())!;
  setSession('demo', owner.id);
  shops = await db.shops.toArray(); products = (await db.products.toArray()).filter(p => p.active);
});
const stock = async (pid: string) => (await db.batches.where('productId').equals(pid).toArray()).reduce((a, b) => a + b.qty, 0);
async function pickedOrder(shop: Shop, p: Product, qty: number, extra = {}) {
  const cs = new ChangeSet(); const o = await bookOrder(cs, shop, [{ productId: p.id, qty, rate: p.rate }], 'test', extra); await cs.commit('booked');
  await approveOrder(o.id);
  const pick = await suggestPick((await db.orders.get(o.id))!);
  await pickOrder(o.id, pick.map(x => ({ productId: x.productId, qty: Math.min(qty, x.available) })));
  return o.id;
}

describe('review fixes', () => {
  it('a delivery keeps the shop photo once on the bill, and no copy in the history log (pre-pilot, 11 Nov 2026)', async () => {
    const p = products[2]; const id = await pickedOrder(shops[2], p, 2);
    const { invoices } = await approvePicked(id);
    const photo = 'data:image/jpeg;base64,' + 'C'.repeat(40000);
    const batch = await recordDelivery([invoices[0].id], { shopPhoto: photo });
    const inv = (await db.invoices.get(invoices[0].id))!;
    expect(inv.delivery?.shopPhoto).toBe(photo);
    expect(inv.delivery?.photo).toBeUndefined();
    expect(JSON.stringify(await db.audit.where('batchId').equals(batch!).toArray())).not.toContain('CCCCCCCC');
  });

  it('a double tap on Done → bill makes one bill and takes stock once', async () => {
    const p = products[0]; const id = await pickedOrder(shops[0], p, 6);
    const s0 = await stock(p.id);
    const res = await Promise.allSettled([approvePicked(id), approvePicked(id)]);
    expect(res.filter(r => r.status === 'fulfilled').length).toBe(1);
    await expect(approvePicked(id)).rejects.toThrow(/already billed/);
    expect((await db.invoices.toArray()).filter(i => i.orderId === id && !i.cancelled).length).toBe(1);
    expect(await stock(p.id)).toBe(s0 - 6);
  });

  it('a bill is dated the day it is made, not the order day', async () => {
    const p = products[1]; const id = await pickedOrder(shops[1], p, 3, { date: daysFrom(-1) });
    const { invoices } = await approvePicked(id);
    expect(invoices[0].date).toBe(today());
  });

  it('undo is refused when a later action changed the same records, and never re-issues a bill number', async () => {
    const p = products[2];
    const a = await approvePicked(await pickedOrder(shops[0], p, 3));
    await approvePicked(await pickedOrder(shops[0], p, 3)); // same batch, later
    const before = await stock(p.id);
    expect(await undoBatch(a.batchId)).toBe(-1);
    expect(await stock(p.id)).toBe(before);
    const c = await approvePicked(await pickedOrder(shops[0], p, 1));
    const numbers = (await db.invoices.toArray()).map(i => i.number);
    expect(numbers.filter(n => n === c.invoices[0].number).length).toBe(1);
  });

  it('a paid bill credited below zero becomes shop advance', async () => {
    // a fresh shop with no other bills, so nothing else moves its balance (deterministic — Part 2 batch 1 review)
    const c0 = new ChangeSet(); const shop = c0.put<Shop>('shops', { ...shops[2], id: undefined as never, name: 'Fresh Advance Shop' }); await c0.commit('fresh shop');
    const p = products[0];
    const { invoices: [inv] } = await approvePicked(await pickedOrder(shop, p, 4));
    const before = await shopOutstanding(shop.id);
    const cs = new ChangeSet();
    cs.put('payments', { shopId: shop.id, amount: inv.total, mode: 'cash', date: today(), collectedBy: 'test', shopConfirmed: true, allocations: [{ invoiceId: inv.id, amount: inv.total }], advance: 0, settled: true, status: 'ok' });
    await cs.commit('paid');
    // one piece short at the door → credit note on an already-paid bill
    await db.invoices.put({ ...(await db.invoices.get(inv.id))!, deliveryStatus: 'partial', delivery: { at: '', by: '', shortages: [{ productId: p.id, qty: 1, reason: 'short' }], excess: [] } });
    await settleDifference(inv.id, 'credit_note');
    const cn = (await db.creditNotes.where('invoiceId').equals(inv.id).toArray())[0];
    const after = await shopOutstanding(shop.id);
    // paid in full, then credited: the credit is applied to the shop's other open bills (or kept as advance)
    expect(after.total).toBeCloseTo(before.total - inv.total - cn.total, 1);
  });

  it('credit-note numbers never repeat and use the financial year', async () => {
    const cs = new ChangeSet(); const a = await creditNoteNumbers(cs, 2); await cs.commit('cn');
    const cs2 = new ChangeSet(); const b = await creditNoteNumbers(cs2, 1); await cs2.commit('cn');
    expect(new Set([...a, ...b]).size).toBe(3);
    expect(a[0]).toMatch(new RegExp(`^CN/${finYear(today())}/\\d{5}$`));
  });

  it('guards refuse impossible saves and write nothing', async () => {
    const b = (await db.batches.toArray()).find(x => x.qty > 0)!;
    const cs = new ChangeSet(); cs.put('batches', { ...b, qty: -1 }); cs.put('expenses', { date: today(), category: 'test', amount: 5 });
    await expect(cs.commit('bad')).rejects.toThrow(/below zero/);
    expect((await db.batches.get(b.id))!.qty).toBe(b.qty);
    expect((await db.expenses.toArray()).some(e => e.category === 'test')).toBe(false); // whole save rolled back
    const inv = (await db.invoices.toArray())[0];
    const cs2 = new ChangeSet(); cs2.put('invoices', { ...inv, id: undefined });
    await expect(cs2.commit('dup')).rejects.toThrow(/already used/);
    const cs3 = new ChangeSet(); cs3.put('payments', { shopId: inv.shopId, amount: 100, mode: 'cash', date: today(), collectedBy: 't', shopConfirmed: true, allocations: [{ invoiceId: inv.id, amount: 150 }], advance: 0, settled: false, status: 'ok' });
    await expect(cs3.commit('over')).rejects.toThrow(/more than its amount/);
  });

  it('new guards (Nov 2026 money review): credit notes never beyond the bill, money is a number, a company bill once, short bill prefix', async () => {
    const inv = (await db.invoices.toArray()).find(i => !i.cancelled)!;
    const cn = new ChangeSet(); cn.put('creditNotes', { number: 'CN/G/1', invoiceId: inv.id, shopId: inv.shopId, companyId: inv.companyId, date: today(), reason: 'x', lines: [], total: inv.total + 5 });
    await expect(cn.commit('too big')).rejects.toThrow(/more than/);
    const nan = new ChangeSet(); nan.put('claimEntries', { companyId: inv.companyId, month: '2026-11', kind: 'damage', qty: 1, amount: NaN }); await expect(nan.commit('nan')).rejects.toThrow(/not a valid number/);
    const p1 = new ChangeSet(); p1.put('purchases', { companyId: inv.companyId, billNo: 'GRD-1', date: today(), lines: [], taxable: 1, tax: 0, total: 1, source: 'typed' }); await p1.commit('p1');
    const p2 = new ChangeSet(); p2.put('purchases', { companyId: inv.companyId, billNo: 'grd-1', date: today(), lines: [], taxable: 1, tax: 0, total: 1, source: 'typed' }); await expect(p2.commit('p2')).rejects.toThrow(/already entered/);
    const st = new ChangeSet(); st.put('settings', { ...(await db.settings.toArray())[0], billPrefix: 'TOOLONG' }); await expect(st.commit('prefix')).rejects.toThrow(/prefix/);
  });

  it('month end is the real last day of the month (no UTC shift)', () => {
    expect(monthEnd('2027-03')).toBe('2027-03-31');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
  });
});

// Round 3 (11 Nov 2026): the guard's new rules (QUALITY.md table)
describe('round 3 guard rules', () => {
  it('a bill line without its stock lots is refused with a plain message (not a crash)', async () => {
    const inv = (await db.invoices.toArray()).find(i => !i.cancelled && i.lines.length)!;
    const cs = new ChangeSet(); cs.put('invoices', { ...inv, lines: inv.lines.map(l => ({ ...l, batches: undefined })) });
    await expect(cs.commit('x')).rejects.toThrow(/has no stock lots/);
  });
  it('an old due of ₹0 (or a NaN one) is refused', async () => {
    const shop = (await db.shops.toArray())[0];
    for (const amount of [0, Number.NaN]) {
      const cs = new ChangeSet(); cs.put('openingDues', { shopId: shop.id, ref: 'X', date: today(), amount });
      await expect(cs.commit('x')).rejects.toThrow(/old due|Money amount/);
    }
  });
});

// Security standard round (13 Nov 2026): the history log copied each saved record whole — a staff member's PIN, typed by
// the owner, went into the audit entry (before/after), which is kept on the phone and synced to the server for good.
describe('a staff PIN never goes into the history log', () => {
  it('adding staff and changing their PIN leaves no PIN in any audit entry', async () => {
    const cs = new ChangeSet(); const s = cs.put('staff', { name: 'Audit Test', phone: '9811100001', role: 'salesman', pin: '7265', active: true }, 'add staff'); await cs.commit('Staff added');
    const cs2 = new ChangeSet(); cs2.put('staff', { ...s, pin: '4826' }, 'pin changed'); await cs2.commit('PIN changed');
    const entries = (await db.audit.toArray()).filter(a => a.recordId === s.id);
    expect(entries.length).toBe(2);
    expect(JSON.stringify(entries)).not.toMatch(/7265|4826/);
  });
});
