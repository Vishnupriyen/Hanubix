// Profit and loss for today or this month: the same numbers on the P&L screen and in TESRAX's answer (owner only).
//   profit = sales before GST − credit notes before GST + company-scheme claims − cost of the pieces shops kept
//            − expenses − full salary
// Sales are already net of every discount (own schemes are not a second cost). Cost is at the batch's buying rate where
// a company bill shows it, else the rate stamped on the bill line when billed (a later rate change never rewrites a past
// month), else the product's buying rate. Advance recoveries are still salary (the full salary is the cost).
import { db, localDay, today } from './db';
import { r2 } from './ledger';
import { cnTaxLines } from './gst';
import { DELIVERY_REASONS } from './pipeline';

export type PnlHead = { key: string; label: string; amount: number; items: { d: string; t: string; v: number }[] };
/** the money the owner has now: ONE number for the P&L screen, Cash flow and TESRAX. Cash in hand = cash the office has received
 *  (settled) − approved cash expenses (+ other income); bank = every bank-statement line; with staff = cash not yet handed over. */
export async function moneyPosition() {
  const pays = (await db.payments.toArray()).filter(p => p.status === 'ok');
  const exps = (await db.expenses.toArray()).filter(e => e.approved && e.status !== 'rejected');
  const cashIn = pays.filter(p => p.mode === 'cash' && p.settled).reduce((a, p) => a + p.amount, 0);
  const cashOut = exps.filter(e => e.category !== 'income').reduce((a, e) => a + e.amount, 0) - exps.filter(e => e.category === 'income').reduce((a, e) => a + e.amount, 0);
  const bank = r2((await db.bankLines.toArray()).reduce((a, b) => a + b.credit - b.debit, 0));
  const staff = r2(pays.filter(p => p.mode === 'cash' && !p.settled).reduce((a, p) => a + p.amount, 0));
  return { cash: r2(cashIn - cashOut), bank, staff, total: r2(cashIn - cashOut + bank + staff) };
}
export interface Pnl { income: PnlHead[]; expense: PnlHead[]; cash: number; bank: number; staff: number }
const month = () => today().slice(0, 7);

export async function profitAndLoss(period: 'today' | 'month'): Promise<Pnl> {
  type Head = PnlHead;
  const from = period === 'today' ? today() : month();
  const inRange = (dt: string) => period === 'today' ? dt === from : dt.startsWith(from);
  const allInvs = await db.invoices.toArray();
  const invById = new Map(allInvs.map(i => [i.id, i]));
  const invs = allInvs.filter(i => !i.cancelled && inRange(i.date));
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const cos = new Map((await db.companies.toArray()).map(c => [c.id, c.name]));
  const shops = new Map((await db.shops.toArray()).map(s => [s.id, s.name]));
  const allCns = await db.creditNotes.toArray();
  const cns = allCns.filter(c => inRange(c.date) && invById.get(c.invoiceId)?.cancelled == null);
  const income: Head[] = [];
  // Sales by company (before tax)
  for (const [cid, name] of cos) { const ci = invs.filter(i => i.companyId === cid); if (!ci.length) continue; income.push({ key: 'sales-' + cid, label: `Sales · ${name}`, amount: r2(ci.reduce((a, i) => a + i.taxable, 0)), items: ci.map(i => ({ d: i.date, t: `${i.number} · ${shops.get(i.shopId) ?? ''}`, v: i.taxable })) }); }
  const other = invs.filter(i => !cos.has(i.companyId)); if (other.length) income.push({ key: 'sales-x', label: 'Sales · other', amount: r2(other.reduce((a, i) => a + i.taxable, 0)), items: other.map(i => ({ d: i.date, t: i.number, v: i.taxable })) });
  // credit notes before GST (the GST on them goes back to the government return, not into profit)
  const cnTaxable = (c: typeof cns[0]) => r2(cnTaxLines(c, invById.get(c.invoiceId)).reduce((a, r) => a + r.taxable, 0));
  if (cns.length) income.push({ key: 'cn', label: 'Returns / credit notes (before GST)', amount: -r2(cns.reduce((a, c) => a + cnTaxable(c), 0)), items: cns.map(c => ({ d: c.date, t: `${c.number} · ${shops.get(c.shopId) ?? ''} · ${c.reason}`, v: -cnTaxable(c) })) });
  // company-scheme claims only: lines of live bills (a cancelled or fully credited bill's lines are dropped with it)
  const schemes = await db.schemes.toArray();
  const isOwn = (c: { productId?: string; companyId: string }) => schemes.some(s => s.source === 'own' && (s.productId === c.productId || !s.productId) && s.companyId === c.companyId) && !schemes.some(s => s.source === 'company' && (s.productId === c.productId || !s.productId) && s.companyId === c.companyId);
  const claimDay = (c: { invoiceId?: string; createdAt: string }) => (c.invoiceId && invById.get(c.invoiceId)?.date) || localDay(c.createdAt);
  const coClaims = (await db.claimEntries.toArray()).filter(c => c.kind === 'scheme' && !c.dropped && c.invoiceId && invById.has(c.invoiceId) && !invById.get(c.invoiceId)!.cancelled && !isOwn(c) && inRange(claimDay(c)));
  if (coClaims.length) income.push({ key: 'claims', label: 'Company scheme claims', amount: r2(coClaims.reduce((a, c) => a + c.amount, 0)), items: coClaims.map(c => ({ d: claimDay(c), t: `${cos.get(c.companyId) ?? ''} · ${products.get(c.productId ?? '')?.name ?? c.kind}`, v: c.amount })) });
  const exps = (await db.expenses.toArray()).filter(e => inRange(e.date) && e.category !== 'advance' && e.status !== 'rejected');
  const incExp = exps.filter(e => e.category === 'income'); if (incExp.length) income.push({ key: 'other-income', label: 'Other income', amount: r2(incExp.reduce((a, e) => a + e.amount, 0)), items: incExp.map(e => ({ d: e.date, t: e.note ?? '', v: e.amount })) });

  // cost of the pieces the shops kept: pieces still out on the bill + pieces written off as damaged (not back in stock)
  const { byLot, byBatch } = await lotCostRates();
  const buy = (pid: string) => { const r = products.get(pid)?.purchaseRate; return typeof r === 'number' && Number.isFinite(r) ? r : 0; };
  const restockLabel = new Set<string>(DELIVERY_REASONS.filter(r => r.restock).map(r => r.label));
  const cogsItems = invs.map(i => {
    const damaged = (pid: string) => (i.delivery?.shortages ?? []).filter(x => x.productId === pid && !restockLabel.has(x.reason)).reduce((a, x) => a + x.qty, 0)
      + allCns.filter(c => c.invoiceId === i.id && c.source === 'return').flatMap(c => c.lines).filter(l => l.productId === pid && !l.restock).reduce((a, l) => a + l.qty + (l.freeQty ?? 0), 0);
    const seen = new Set<string>();
    let v = 0;
    for (const l of i.lines) {
      // cost: the batch's rate on its company bill, else the rate stamped on the line when billed, else today's rate
      const lineRate = typeof l.costRate === 'number' && Number.isFinite(l.costRate) ? l.costRate : buy(l.productId);
      for (const b of l.batches) v += b.qty * (byLot.get(b.batchId) ?? byBatch.get(`${l.productId}|${b.batch}`) ?? lineRate);
      if (!seen.has(l.productId)) { seen.add(l.productId); v += damaged(l.productId) * lineRate; }
    }
    return { d: i.date, t: i.number, v: r2(v) };
  });
  const expense: Head[] = [];
  expense.push({ key: 'cogs', label: 'Cost of goods sold (pieces kept by shops)', amount: r2(cogsItems.reduce((a, x) => a + x.v, 0)), items: cogsItems });
  const cost = (e: typeof exps[0]) => e.category === 'salary' ? (e.gross ?? e.amount) : e.amount; // salary: the full salary, recoveries included
  const byCat = new Map<string, typeof exps>(); for (const e of exps) { if (e.category === 'income') continue; byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]); }
  for (const [k, list] of [...byCat.entries()].sort((a, b) => b[1].reduce((x, e) => x + cost(e), 0) - a[1].reduce((x, e) => x + cost(e), 0))) expense.push({ key: 'exp-' + k, label: k[0].toUpperCase() + k.slice(1), amount: r2(list.reduce((a, e) => a + cost(e), 0)), items: list.map(e => ({ d: e.date, t: e.note || k, v: cost(e) })) });
  // cash, bank and cash with staff are what the owner has NOW (not the period's): the same figures as Cash flow
  const pos = await moneyPosition();
  return { income, expense, cash: pos.cash, bank: pos.bank, staff: pos.staff };
}

/** income − expenses, and profit as a share of income (whole percent) */
export function pnlTotals(d: Pnl) {
  const income = r2(d.income.reduce((a, h) => a + h.amount, 0)), expense = r2(d.expense.reduce((a, h) => a + h.amount, 0));
  const profit = r2(income - expense);
  return { income, expense, profit, pct: income ? Math.round(profit / income * 100) : 0 };
}

/** what each lot cost on its purchase bill: by the lot itself (a purchase line names its lot — the same product on two
 *  lines of one bill is two lots, each its own rate), else by product + batch for older purchases (the latest bill wins) */
export async function lotCostRates() {
  const byLot = new Map<string, number>();
  const latest = new Map<string, { date: string; rate: number }>();
  for (const pu of await db.purchases.toArray()) for (const l of pu.lines) {
    if (!(l.rate > 0)) continue;
    if (l.batchId) byLot.set(l.batchId, l.rate);
    if (!l.batch) continue; const k = `${l.productId}|${l.batch}`; const was = latest.get(k);
    if (!was || pu.date >= was.date) latest.set(k, { date: pu.date, rate: l.rate });
  }
  return { byLot, byBatch: new Map([...latest].map(([k, v]) => [k, v.rate])) };
}
