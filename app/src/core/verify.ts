// "Verify picked" (Part 2 item 9 — docs/PART2_SPEC.md, PART2_UX.md 2c): the bill table with Ordered and Picked per order line.
// Picked defaults to what was ordered; short picks show red, extra amber; qty, rate and Disc % can change here; "Make bill" is
// blocked with the reason when stock can't cover it. The order is billed once (approvePicked's lock and status check).
import { ChangeSet, db, nowIso, session, today } from './db';
import { activeSchemes, applySchemes } from './billing';
import { lineOf, pickedLines } from './lines';
import { approvePicked } from './pipeline';
import type { Order } from './types';

type Part = NonNullable<Order['picked']>[number];
export interface VerifyRow {
  line: number; productId: string; ordered: number; picked: number; rate: number; discountPct?: number;
  state: 'ok' | 'short' | 'extra'; note: string; parts: Part[]; // parts: the packed rows of this line (two MRP lots = two parts)
}
const judge = (r: Omit<VerifyRow, 'state' | 'note'>): VerifyRow => {
  const d = r.picked - r.ordered;
  return { ...r, state: d < 0 ? 'short' : d > 0 ? 'extra' : 'ok', note: d < 0 ? `${-d} short` : d > 0 ? `${d} extra` : '' };
};

/** one row per order line: what was ordered, what was packed (defaults to ordered when nothing was packed for it) */
export function verifyRows(o: Pick<Order, 'lines' | 'picked'>): VerifyRow[] {
  const packed = o.picked ? pickedLines(o) : [];
  return o.lines.map((l, i) => {
    const n = lineOf(l, i);
    const parts = packed.filter(p => p.line === n);
    const picked = o.picked ? parts.reduce((a, p) => a + p.qty, 0) : l.qty;
    return judge({ line: n, productId: l.productId, ordered: l.qty, picked, rate: l.rate, discountPct: l.discountPct, parts: parts.length ? parts : [{ productId: l.productId, qty: picked, line: n }] });
  });
}
/** "Verify all": every line as ordered */
export const verifyAll = (rows: VerifyRow[]) => rows.map(r => judge({ ...r, picked: r.ordered }));
/** a row with a new Picked number: judged again */
export const setPicked = (r: VerifyRow, picked: number) => judge({ ...r, picked: Math.max(0, Math.floor(picked) || 0) });

/** the reason "Make bill" can't go ahead, or null: stock (not expired) must cover the paid + scheme-free pieces of each product */
export async function makeBillBlock(_o: Pick<Order, 'lines'>, rows: VerifyRow[]): Promise<string | null> {
  if (!rows.some(r => r.picked > 0)) return 'Nothing picked. Cancel the order instead';
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = await db.schemes.toArray(); const t = today();
  const need = new Map<string, number>();
  for (const r of rows) {
    const p = products.get(r.productId); if (!p || r.picked <= 0) continue;
    if (!(r.rate > 0)) return `Rate for ${p.name} must be more than ₹0`;
    if (r.discountPct != null && !(Number.isFinite(r.discountPct) && r.discountPct >= 0 && r.discountPct <= 100)) return "Discount can't be more than 100%"; // NaN or below 0 too
    const free = applySchemes(p, r.picked, r.rate, activeSchemes(schemes, p, t)).freeQty;
    need.set(p.id, (need.get(p.id) ?? 0) + r.picked + free);
  }
  for (const [pid, n] of need) {
    const have = (await db.batches.where('productId').equals(pid).toArray()).filter(b => b.qty > 0 && b.expiry >= t).reduce((a, b) => a + b.qty, 0);
    if (n > have) return `Stock short for ${products.get(pid)?.name ?? 'an item'}`;
  }
  return null;
}

/** the packed rows for a row's Picked number: the earlier lots keep up to what was packed from them and the LAST lot takes
 *  the rest (more picked than packed lands on the last lot; fewer empties the last lots first, the first lot is always kept) */
function partsFor(r: VerifyRow): Part[] {
  let left = r.picked;
  const out = r.parts.map((p, k) => { const take = k === r.parts.length - 1 ? left : Math.min(left, p.qty); left -= take; return { ...p, qty: take, line: r.line }; });
  return out.filter((p, k) => p.qty > 0 || k === 0);
}

const verifying = new Set<string>();
/** save what was verified (picked qty, rate, Disc % per line) and make the bill. A double tap bills once. */
export async function verifyAndBill(orderId: string, rows: VerifyRow[]) {
  if (verifying.has(orderId)) throw new Error('This order is already being billed.');
  verifying.add(orderId);
  try {
    const o = await db.orders.get(orderId);
    if (!o) throw new Error('Order not found.');
    if (o.status !== 'picked') throw new Error(o.status === 'billed' ? 'This order is already billed.' : o.status === 'cancelled' ? 'This order was already cancelled.' : 'This order is not packed yet.');
    const block = await makeBillBlock(o, rows);
    if (block) throw new Error(block);
    const by = new Map(rows.map(r => [r.line, r]));
    const lines = o.lines.map((l, i) => { const r = by.get(lineOf(l, i)); return r ? { ...l, rate: r.rate, ...(r.discountPct != null ? { discountPct: r.discountPct } : {}) } : l; });
    const picked = rows.flatMap(partsFor);
    const changed = rows.filter(r => r.state !== 'ok').map(r => `${r.note} on line ${r.line}`);
    const cs = new ChangeSet();
    cs.put<Order>('orders', { ...o, lines, picked, activity: [...(o.activity ?? []), { at: nowIso(), by: session().userId, what: `verified${changed.length ? `: ${changed.join(', ')}` : ''}` }] }, 'verified');
    await cs.commit('Verified');
    return await approvePicked(orderId);
  } finally { verifying.delete(orderId); }
}
