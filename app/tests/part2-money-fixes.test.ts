// Part 2 batch 1 fixes, group 3 (gst-accounts-specialist). Each test failed before its fix.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
const captured: Record<string, unknown> = {};
vi.mock('../src/core/readers', async (orig) => ({ ...(await orig() as object),
  downloadWorkbook: async (name: string, sheets: unknown) => { captured[name] = sheets; },
  downloadText: (name: string, text: string) => { captured[name] = text; } }));
import { ChangeSet, db, setSession, today } from '../src/core/db';
import { seedDemo, gstinWithCheck } from '../src/core/seed';
import { exportEinvoice, exportGstr1 } from '../src/core/exports';
import { makeInvoices } from '../src/core/billing';
import { splitShort } from '../src/core/credit';
import { cancelInvoice } from '../src/core/pipeline';
import { allOutstanding, receivablesAgeing, shopOutstanding } from '../src/core/ledger';
import { shopStatement } from '../src/core/statement';
import { ownerNumbers } from '../src/core/ownerCard';
import type { Batch, Order, Product, Scheme, Shop } from '../src/core/types';

let owner = '', shop: Shop, tea: Product, sc: Scheme;
beforeAll(async () => {
  await seedDemo();
  owner = (await db.staff.toArray()).find(s => s.role === 'owner')!.id;
  setSession('demo', owner);
  const st = await db.settings.toCollection().first();
  shop = (await db.shops.toArray()).find(s => s.approved && !s.gstin && (!s.stateCode || s.stateCode === st?.stateCode))!;
  const co = (await db.companies.toArray())[0];
  const cs = new ChangeSet();
  tea = cs.put<Product>('products', { companyId: co.id, name: 'Test Tea 0902', hsn: '0902', gst: 5, mrp: 120, rate: 100, purchaseRate: 80, caseSize: 10, aliases: [], active: true });
  cs.put<Batch>('batches', { productId: tea.id, batch: 'TT1', expiry: '2030-01-01', mrp: 120, qty: 500, purchaseRate: 80 } as Batch);
  sc = cs.put<Scheme>('schemes', { companyId: co.id, productId: tea.id, name: 'Company 10% off', type: 'pct', value: 10, from: '2026-01-01', to: '2030-12-31', source: 'company', combine: 'add' } as Scheme);
  await cs.commit('test stock');
});
beforeEach(() => setSession('demo', owner));
const order = (lines: Order['lines']): Order => ({ id: `o-${Math.random()}`, tenantId: 'demo', createdAt: '', updatedAt: '', dirty: 0, shopId: shop.id, source: 'office', lines, status: 'picked', issues: [], date: today(), invoiceIds: [] });
const bill = async (lines: Order['lines']) => { const cs = new ChangeSet(); const [inv] = await makeInvoices(cs, order(lines), shop); await cs.commit('Approved & billed'); return (await db.invoices.get(inv.id))!; };
const claimOf = async (invId: string) => (await db.claimEntries.toArray()).filter(c => c.invoiceId === invId && c.kind === 'scheme' && !c.dropped).reduce((a, c) => a + c.amount, 0);

describe('scheme claim = what the shop was actually given, company schemes only', () => {
  it('scheme 10%, Disc % set to 4 → claim 4% (₹40 on ₹1,000); Disc % 0 → no claim; no Disc % → the scheme\'s 10%', async () => {
    const a = await bill([{ productId: tea.id, qty: 10, rate: 100, discountPct: 4, line: 1 }]);
    expect(a.lines[0].discount).toBe(40);
    expect(await claimOf(a.id)).toBe(40);
    const b = await bill([{ productId: tea.id, qty: 10, rate: 100, discountPct: 0, line: 1 }]);
    expect(await claimOf(b.id)).toBe(0);
    const c = await bill([{ productId: tea.id, qty: 10, rate: 100, line: 1 }]);
    expect(await claimOf(c.id)).toBe(100);
    for (const i of [a, b, c]) await cancelInvoice(i.id, 'test');
  });
});

describe('a short delivery splits paid and free pieces on the product\'s combined qty', () => {
  it('buy 10 get 1 over two lines of 6: 1 short on line 1 is a PAID piece (the shop still has 11 paid, the free is earned)', () => {
    const free: Scheme = { ...sc, id: 'f', name: 'Buy 10 get 1', type: 'free', value: 0, buyQty: 10, freeQty: 1 } as Scheme;
    const line1 = { productId: tea.id, qty: 6, freeQty: 1, rate: 100 } as never;
    expect(splitShort(line1, 1, tea, [free], today(), 6)).toEqual({ paid: 1, free: 0 });
    // one line alone (nothing else of the product on the bill): unchanged
    expect(splitShort({ productId: tea.id, qty: 10, freeQty: 1, rate: 100 } as never, 1, tea, [free], today())).toEqual({ paid: 1, free: 0 });
  });
});

describe('GSTR-1 and e-invoice use the bill\'s own HSN key (HSN + UQC + rate) and the product\'s unit', () => {
  it('one HSN at one rate in pieces and in kilograms: two HSN rows, each with its own UQC and its own description', async () => {
    const co = (await db.companies.toArray())[0];
    const cs = new ChangeSet();
    const pcs = cs.put<Product>('products', { companyId: co.id, name: 'Dust Tea Pack', hsn: '09024099', gst: 5, mrp: 60, rate: 50, caseSize: 10, aliases: [], active: true });
    const kgs = cs.put<Product>('products', { companyId: co.id, name: 'Loose Tea Kg', hsn: '09024099', gst: 5, mrp: 400, rate: 300, caseSize: 1, aliases: [], active: true, unit: 'KGS' } as Product);
    cs.put<Batch>('batches', { productId: pcs.id, batch: 'D1', expiry: '2030-01-01', mrp: 60, qty: 50 } as Batch);
    cs.put<Batch>('batches', { productId: kgs.id, batch: 'L1', expiry: '2030-01-01', mrp: 400, qty: 50 } as Batch);
    const b2b = cs.put<Shop>('shops', { name: 'Unit Test Traders', area: 'Pennadam', beat: 'Monday', gstin: gstinWithCheck('33AAKFU1234M1Z'), creditLimit: 50000, creditDays: 15, cashOnly: false, type: 'retail', approved: true, aliases: [], address: 'Main Road, Pennadam 606105' });
    await cs.commit('unit test setup');
    const c2 = new ChangeSet(); const [inv] = await makeInvoices(c2, { ...order([{ productId: pcs.id, qty: 4, rate: 50, line: 1 }, { productId: kgs.id, qty: 2, rate: 300, line: 2 }]), shopId: b2b.id }, b2b); await c2.commit('bill');
    await (await exportGstr1(today().slice(0, 7))).actions![0].run();
    const sheets = captured[`Hanubix-GSTR1-${today().slice(0, 7)}`] as { name: string; rows: (string | number)[][] }[];
    const rows = sheets.find(x => x.name === 'hsn(b2b)')!.rows.filter(r => r[0] === '09024099');
    expect(rows.map(r => [r[1], r[2], r[3], r[5], r[6]])).toEqual([['Dust Tea Pack', 'PCS-PIECES', 4, 5, 200], ['Loose Tea Kg', 'KGS-KILOGRAMS', 2, 5, 600]]);
    await (await exportEinvoice(today().slice(0, 7))).actions![0].run();
    const docs = JSON.parse(captured[`Hanubix-einvoice-${today().slice(0, 7)}.json`] as string) as { DocDtls: { No: string }; ItemList: { Unit: string }[] }[];
    expect(docs.find(d => d.DocDtls.No === inv.number)!.ItemList.map(x => x.Unit)).toEqual(['PCS', 'KGS']);
    await cancelInvoice(inv.id, 'test');
  });
});

describe('every paisa owed stays in the dues (no hiding balances of ₹0.50 or less)', () => {
  it('a bill with ₹0.30 left shows in the shop\'s dues, every shop\'s dues, ageing, the statement and the owner card', async () => {
    const c0 = new ChangeSet(); const fresh = c0.put<Shop>('shops', { ...shop, id: undefined as never, name: 'Paise Left Store' }); await c0.commit('fresh shop');
    const c1 = new ChangeSet(); const [inv] = await makeInvoices(c1, { ...order([{ productId: tea.id, qty: 3, rate: 100, discountPct: 0, line: 1 }]), shopId: fresh.id }, fresh); await c1.commit('bill');
    const owners0 = (await ownerNumbers()).outstanding;
    const cs = new ChangeSet();
    cs.put('payments', { shopId: fresh.id, amount: inv.total - 0.3, mode: 'cash', date: today(), collectedBy: owner, shopConfirmed: true, allocations: [{ invoiceId: inv.id, amount: inv.total - 0.3 }], advance: 0, settled: true, status: 'ok' });
    await cs.commit('paid all but 30 paise');
    const o = await shopOutstanding(fresh.id);
    expect(o.total).toBe(0.3); expect(o.bills.map(b => b.balance)).toEqual([0.3]);
    expect((await allOutstanding()).get(fresh.id)?.total).toBe(0.3);
    expect((await receivablesAgeing()).rows.find(r => r.shopId === fresh.id)?.total).toBe(0.3);
    const st = (await shopStatement(fresh.id))!;
    expect(st.rows.some(r => r.kind === 'round')).toBe(false); // no "treated as settled" patch line
    expect(st.due.total).toBe(0.3);
    expect(r2((await ownerNumbers()).outstanding - owners0)).toBe(r2(0.3 - inv.total));
  });
});
const r2 = (n: number) => Math.round(n * 100) / 100;
