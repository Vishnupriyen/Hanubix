// The shop statement as a file (12 Nov 2026, owner: "every report it should send"). Same figures as the Shop statement
// screen: every bill, payment, credit note and old due, oldest first, the balance after each, closing = balance due.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, vi } from 'vitest';
const sent: { name: string; sheets: { name: string; header: string[]; rows: (string | number)[][] }[] }[] = [];
vi.mock('../src/core/readers', async (orig) => ({ ...(await orig<object>()), downloadWorkbook: async (name: string, sheets: never) => { sent.push({ name, sheets }); } }));
import { db, setSession } from '../src/core/db';
import { seedDemo } from '../src/core/seed';
import { handle } from '../src/core/engine';
import { sendStatement, shopStatement, withBalance } from '../src/core/statement';
import type { Role } from '../src/core/types';
const ids: Partial<Record<Role, string>> = {};
beforeAll(async () => { await seedDemo(); for (const s of await db.staff.toArray()) ids[s.role] ??= s.id; setSession('demo', ids.owner!); });

async function busiest() {
  const shops = await db.shops.toArray(); let best = shops[0], n = -1;
  for (const s of shops) { const d = await shopStatement(s.id); if (d && d.rows.length > n) { n = d.rows.length; best = s; } }
  return best;
}
describe('shop statement file', () => {
  it('the file closes on the balance due, and each balance follows from the one before', async () => {
    const shop = await busiest(); const d = (await shopStatement(shop.id))!;
    expect(d.rows.length).toBeGreaterThan(1);
    sent.length = 0; await sendStatement(shop.id);
    const all = sent[0].sheets[0].rows; const rows = all.slice(all.findIndex(r => r[0] === 'Date') + 1); // after the column names
    const closing = rows.find(r => r[1] === 'Balance due')!;
    expect(closing[5]).toBeCloseTo(d.due.total, 2);
    const body = rows.filter(r => r[0] && r[1] !== 'Opening balance'); let bal = 0;
    for (const r of body) { bal = Math.round((bal + Number(r[3] || 0) - Number(r[4] || 0)) * 100) / 100; expect(Number(r[5])).toBeCloseTo(bal, 2); }
    expect(sent[0].sheets[0].header[0]).toContain(shop.name);
  });
  it('a period starts from the opening balance before it', async () => {
    const shop = await busiest(); const d = (await shopStatement(shop.id))!;
    const dates = withBalance(d).map(r => r.at.slice(0, 10)).sort(); const from = dates[Math.floor(dates.length / 2)];
    sent.length = 0; await sendStatement(shop.id, from, '2099-12-31');
    const all = sent[0].sheets[0].rows; const rows = all.slice(all.findIndex(r => r[0] === 'Date') + 1);
    expect(rows[0][1]).toBe('Opening balance');
    const before = withBalance(d).reverse().filter(r => r.at.slice(0, 10) < from);
    expect(rows[0][5]).toBe(before.length ? before[before.length - 1].balance : 0);
  });
});
describe('TESRAX: "send <shop> statement"', () => {
  it('owner gets the balance in words and a Send statement button', async () => {
    setSession('demo', ids.owner!);
    const shop = await busiest();
    const r = await handle(`send ${shop.name} statement`, [], {});
    expect(r.text).toMatch(new RegExp(`^${shop.name}: balance due ₹`));
    expect(r.actions?.[0].label).toBe('Send statement (Excel)');
    sent.length = 0; await r.actions![0].run(); await new Promise(res => setTimeout(res, 50));
    expect(sent[0].name).toMatch(/^Statement-/);
  });
  it('"<shop> ledger october" is that period; "bank statement" with no shop is still the Bank screen', async () => {
    const shop = await busiest();
    expect((await handle(`${shop.name} ledger october`, [], {})).text).toMatch(/statement for/);
    expect((await handle('bank statement', [], {})).go).toBe('bank');
  });
  it('godown is told who can', async () => {
    setSession('demo', ids.godown!);
    const shop = await busiest();
    const r = await handle(`${shop.name} statement`, [], {});
    expect(r.refused).toBe(true);
    setSession('demo', ids.owner!);
  });
});

// GST & accounts review of the statement file (12 Nov 2026): six problems, each a test first.
describe('statement — accounts review', () => {
  async function freshShop(name: string) {
    const { ChangeSet } = await import('../src/core/db');
    const cs = new ChangeSet();
    const s = cs.put('shops', { name, area: 'Pennadam', beat: 'Monday', gstin: '33AAAAA0000A1Z5', address: '1 Main Road', creditLimit: 100000, creditDays: 15, cashOnly: false, type: 'retail', approved: true, aliases: [] } as never);
    await cs.commit('shop'); return s as unknown as { id: string; name: string };
  }
  let billNo = 0;
  async function bill(shopId: string, amount: number, date: string, extra: object = {}) {
    const { ChangeSet, newId } = await import('../src/core/db');
    const cs = new ChangeSet(); const co = (await db.companies.toArray())[0];
    const id = newId();
    cs.put('invoices', { id, number: `T/${++billNo}`, shopId, companyId: co.id, date, kind: 'B2C', lines: [], taxable: amount, cgst: 0, sgst: 0, igst: 0, roundOff: 0, total: amount, deliveryStatus: 'delivered', cancelled: false, ...extra } as never);
    await cs.commit('bill'); return id;
  }
  async function pay(shopId: string, amount: number, date: string, extra: object = {}) {
    const { ChangeSet } = await import('../src/core/db');
    const { allocateOldestFirst } = await import('../src/core/ledger');
    const { allocations, advance } = await allocateOldestFirst(shopId, amount);
    const cs = new ChangeSet();
    cs.put('payments', { shopId, amount, mode: 'cash', date, collectedBy: ids.owner, shopConfirmed: true, allocations, advance, settled: false, status: 'ok', ...extra } as never);
    await cs.commit('pay');
  }
  const file = async (shopId: string, from?: string, to?: string) => { sent.length = 0; await sendStatement(shopId, from, to); return sent[0].sheets[0]; };
  const cells = (sh: { header: string[]; rows: (string | number)[][] }) => [sh.header, ...sh.rows];

  it('1 a few paise left on a bill: balances add up forward and the closing still equals the app\'s balance due', async () => {
    const s = await freshShop('Dust Stores'); await bill(s.id, 1000, '2026-10-01'); await pay(s.id, 999.7, '2026-10-02');
    const sh = await file(s.id); const all = cells(sh);
    const first = all.find(r => r[1] === 'Bill')!; expect(first[5]).toBe(1000);
    const close = all.find(r => r[1] === 'Balance due')!;
    const { shopOutstanding } = await import('../src/core/ledger');
    expect(close[5]).toBe((await shopOutstanding(s.id)).total);
    // every paisa owed stays (GST review, Part 2 batch 1): ₹0.30 is due, and no "treated as settled" rounding line patches it away
    expect(close[5]).toBe(0.3);
    expect(all.some(r => String(r[1]).startsWith('Rounding'))).toBe(false);
  });
  it('2 a credit note on a cancelled bill is not on the statement', async () => {
    const s = await freshShop('Cancel Stores'); const id = await bill(s.id, 500, '2026-10-01', { cancelled: true });
    const { ChangeSet } = await import('../src/core/db'); const cs = new ChangeSet();
    cs.put('creditNotes', { number: 'CN/X1', invoiceId: id, shopId: s.id, companyId: (await db.companies.toArray())[0].id, date: '2026-10-03', lines: [], taxable: 100, total: 100, reason: 'test', source: 'return' } as never); await cs.commit('cn');
    const all = cells(await file(s.id));
    expect(all.some(r => r[2] === 'CN/X1')).toBe(false);
  });
  it('3 a post-dated cheque is on the day it is dated, not the day it was taken', async () => {
    const s = await freshShop('Cheque Stores'); await bill(s.id, 800, '2026-10-01'); await pay(s.id, 300, '2026-10-02', { mode: 'cheque', chequeDate: '2026-10-20', ref: '123456' });
    const row = cells(await file(s.id)).find(r => r[1] === 'Payment')!;
    expect(row[0]).toMatch(/20 Oct/);
  });
  it('4 a statement up to a past date closes "Balance as on <date>" with no overdue from today', async () => {
    const s = await freshShop('Past Stores'); await bill(s.id, 700, '2026-09-05'); await bill(s.id, 200, '2026-10-05');
    const all = cells(await file(s.id, '2026-09-01', '2026-09-30'));
    const close = all.find(r => String(r[1]).startsWith('Balance as on'))!;
    expect(close[5]).toBe(700); expect(close[6]).toBe('');
    expect(all.some(r => r[1] === 'Balance due')).toBe(false);
  });
  it('5 the heading has the firm and shop GSTIN and address, the period and the date made', async () => {
    const s = await freshShop('Head Stores'); await bill(s.id, 100, '2026-10-01');
    const text = cells(await file(s.id)).slice(0, 6).map(r => r.join(' ')).join('\n');
    expect(text).toMatch(/GSTIN/); expect(text).toMatch(/33AAAAA0000A1Z5/); expect(text).toMatch(/1 Main Road/);
    expect(text).toMatch(/Period: all entries up to/); expect(text).toMatch(/Made on/);
  });
  it('6 a totals row: total debit, total credit, closing', async () => {
    const s = await freshShop('Total Stores'); await bill(s.id, 1000, '2026-10-01'); await pay(s.id, 400, '2026-10-02');
    const tot = cells(await file(s.id)).find(r => r[1] === 'Total')!;
    expect([tot[3], tot[4], tot[5]]).toEqual([1000, 400, 600]);
  });
});
