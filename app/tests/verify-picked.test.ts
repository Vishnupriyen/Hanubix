// Part 2 step 2c, item 9 (docs/PART2_SPEC.md, PART2_UX.md): "Verify picked" — Picked defaults to Ordered, "Verify all", short in
// red / extra in amber, qty, rate and Disc % editable, "Make bill" blocked with the reason when stock is short; billed once.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { ChangeSet, db, setSession } from '../src/core/db';
import { seedDemo } from '../src/core/seed';
import { approveOrder, bookOrder, pickOrder } from '../src/core/pipeline';
import { makeBillBlock, verifyAll, verifyAndBill, verifyRows } from '../src/core/verify';
import { SCREENS } from '../src/core/engine';
import type { Product, Shop } from '../src/core/types';

let owner = '', shop: Shop, ps: Product[] = [];
beforeAll(async () => {
  await seedDemo();
  owner = (await db.staff.toArray()).find(s => s.role === 'owner')!.id;
  shop = (await db.shops.toArray()).find(s => s.approved)!;
  const stock = new Map<string, number>(); for (const b of await db.batches.toArray()) if (b.qty > 0 && b.expiry >= '2026-12-31') stock.set(b.productId, (stock.get(b.productId) ?? 0) + b.qty);
  ps = (await db.products.toArray()).filter(p => (stock.get(p.id) ?? 0) > 60).slice(0, 2);
});
beforeEach(() => setSession('demo', owner));
const packed = async (picked?: number[]) => {
  const cs = new ChangeSet(); const o = await bookOrder(cs, shop, ps.map(p => ({ productId: p.id, qty: 10, rate: p.rate })), owner); await cs.commit('t');
  await approveOrder(o.id);
  const lines = (await db.orders.get(o.id))!.lines;
  await pickOrder(o.id, lines.map((l, i) => ({ productId: l.productId, qty: picked?.[i] ?? l.qty, line: l.line })));
  return (await db.orders.get(o.id))!;
};

describe('Verify picked', () => {
  it('the words "Picked — to verify" appear nowhere; the screen is "Verify picked"', () => {
    expect(SCREENS.find(s => s.page === 'verify')!.name).toBe('Verify picked');
    // the godown can open it too (Ordered/Picked only — PART2_UX.md): a screen word and a Home tile
    expect(SCREENS.find(s => s.page === 'verify')!.roles).toContain('godown');
    const home = readFileSync('src/ui/Home.tsx', 'utf8'); const g = home.slice(home.indexOf("role === 'godown'"));
    expect(g.slice(0, g.indexOf('];'))).toMatch(/page: 'verify'/);
    for (const f of ['src/ui/Home.tsx', 'src/ui/Approve.tsx', 'src/ui/DayClose.tsx', 'src/ui/More.tsx', 'src/core/engine.ts', 'src/App.tsx'])
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/Picked [—–-] to verify/i);
  });
  it('rows: Ordered and Picked per line; short is red ("2 short"), extra amber ("2 extra")', async () => {
    const o = await packed([8, 12]);
    const rows = verifyRows(o);
    expect(rows.map(r => [r.ordered, r.picked, r.state, r.note])).toEqual([[10, 8, 'short', '2 short'], [10, 12, 'extra', '2 extra']]);
  });
  it('"Verify all" sets every line to what was ordered', async () => {
    const o = await packed([8, 12]);
    expect(verifyAll(verifyRows(o)).map(r => [r.picked, r.state])).toEqual([[10, 'ok'], [10, 'ok']]);
  });
  it('Make bill: blocked with the reason when stock is short; billed once with the edited rate and Disc %', async () => {
    const o = await packed();
    const rows = verifyRows(o);
    const big = rows.map((r, i) => (i === 0 ? { ...r, picked: 999999 } : r));
    expect(await makeBillBlock(o, big)).toBe(`Stock short for ${ps[0].name}`);
    await expect(verifyAndBill(o.id, big)).rejects.toThrow(`Stock short for ${ps[0].name}`);
    // a Disc % that is not a number never gets through (Part 2 batch 1 tester finding)
    expect(await makeBillBlock(o, rows.map((r, i) => (i === 0 ? { ...r, discountPct: NaN } : r)))).toBe("Discount can't be more than 100%");
    const edited = rows.map((r, i) => (i === 0 ? { ...r, picked: 6, rate: 40, discountPct: 10 } : r));
    expect(await makeBillBlock(o, edited)).toBeNull();
    const [a, b] = await Promise.allSettled([verifyAndBill(o.id, edited), verifyAndBill(o.id, edited)]);
    expect([a.status, b.status].filter(s => s === 'fulfilled').length).toBe(1);
    const bills = (await db.invoices.toArray()).filter(i => i.orderId === o.id);
    const l = bills.flatMap(x => x.lines).find(x => x.productId === ps[0].id)!;
    expect([l.qty, l.rate, l.discount]).toEqual([6, 40, 24]);
    expect((await db.orders.get(o.id))!.status).toBe('billed');
  });
  it('the godown sees no rates: the Verify screen hides Rate and Disc % for the godown', () => {
    const src = readFileSync('src/ui/Approve.tsx', 'utf8');
    expect(src).toMatch(/const showRates = role !== 'godown'/);
  });
});
