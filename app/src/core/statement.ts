// A shop's statement (ledger): every bill, payment, credit note and old due, with the balance after each.
// One source for the Shop statement screen and the file TESRAX sends ("send Murugan Stores statement").
// Balances run FORWARD (debits − credits, oldest first); where the app treats a few paise left on a bill as settled,
// a "Rounding" line shows it, so the closing always equals the balance due the app shows (GST & accounts review, 12 Nov 2026).
import { db, getSettings, today } from './db';
import { inr, localStamp, showDate } from './i18n';
import { invoiceBalances, openingAsBill, OWED, paymentCounts, r2, shopOutstanding } from './ledger';
import { downloadWorkbook } from './readers';
import type { CreditNote, Invoice, Payment, Shop } from './types';

export type StatementRow = { at: string; kind: 'bill' | 'payment' | 'cn' | 'round'; ref: string; debit: number; credit: number; note: string; inv?: Invoice; cn?: CreditNote };
export interface StatementData { shop: Shop; rows: StatementRow[]; due: { total: number; overdue: number; days: number; advance: number }; staff: Map<string, string>; pending: Payment[] }

/** newest first, as the screen shows it */
export async function shopStatement(shopId: string): Promise<StatementData | null> {
  const shop = await db.shops.get(shopId); if (!shop) return null;
  const staff = new Map((await db.staff.toArray()).map(x => [x.id, x.name.split(' ')[0]]));
  const allInv = await db.invoices.where('shopId').equals(shopId).toArray();
  const live = new Set(allInv.filter(i => !i.cancelled).map(i => i.id));
  const invs = allInv.filter(i => !i.cancelled);
  const allPays = (await db.payments.where('shopId').equals(shopId).toArray()).filter(p => p.status === 'ok');
  const pays = allPays.filter(p => paymentCounts(p)); // a post-dated cheque counts from the date on it
  const pending = allPays.filter(p => !paymentCounts(p));
  const old = await db.openingDues.where('shopId').equals(shopId).toArray();
  const cns = (await db.creditNotes.where('shopId').equals(shopId).toArray()).filter(c => live.has(c.invoiceId)); // a note on a cancelled bill is not in the ledger
  const o = await shopOutstanding(shopId); const bal = (await invoiceBalances(shopId)).filter(b => b.balance > OWED);
  const due = { total: o.total, overdue: o.overdue, days: Math.max(0, ...bal.map(b => b.overdueDays)), advance: o.advance };
  const time = (iso: string) => localStamp(iso).slice(11) || '00:00:00';
  const rows: StatementRow[] = [
    ...invs.map(i => ({ at: `${i.date}T${time(i.createdAt)}`, kind: 'bill' as const, ref: i.number, debit: i.total, credit: 0, note: `${i.lines.length} items · ${i.deliveryStatus}`, inv: i })),
    ...pays.map((p: Payment) => {
      const day = p.mode === 'cheque' && p.chequeDate && p.chequeDate > p.date ? p.chequeDate : p.date; // dated on the cheque, not the day it was taken
      return { at: `${day}T${time(p.createdAt)}`, kind: 'payment' as const, ref: `${p.mode.toUpperCase()}${p.ref ? ' ' + p.ref : ''}`, debit: 0, credit: p.amount, note: `by ${staff.get(p.collectedBy) ?? p.collectedBy}${day !== p.date ? ` · taken ${showDate(p.date)}` : ''}` };
    }),
    ...old.map(x => ({ at: x.date + 'T00:00:00', kind: 'bill' as const, ref: openingAsBill(x).number, debit: x.amount, credit: 0, note: 'opening balance' })),
    ...cns.map((c: CreditNote) => ({ at: `${c.date}T${time(c.createdAt)}`, kind: 'cn' as const, ref: c.number, debit: 0, credit: c.total, note: c.reason, cn: c })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { shop, rows, due, staff, pending };
}

/** the balance after each row (newest first), running forward from the oldest row */
export function withBalance(d: StatementData) {
  let run = 0;
  const fwd = [...d.rows].reverse().map(r => { run = r2(run + r.debit - r.credit); return { ...r, balance: run }; });
  return fwd.reverse();
}

const KIND = { bill: 'Bill', payment: 'Payment', cn: 'Credit note', round: 'Rounding (paise)' } as const;

/** the statement as an Excel file, oldest first, for a period (default: everything) — opens the share sheet on a phone */
export async function sendStatement(shopId: string, from?: string, to?: string) {
  const d = await shopStatement(shopId); if (!d) throw new Error('Shop not found.');
  const st = await getSettings();
  const now = today();
  const upTo = to && to < now ? to : now;
  const past = upTo < now;
  const all = withBalance(d).reverse().filter(r => r.kind !== 'round' || !past); // oldest first; rounding only in a statement to today
  const day = (r: { at: string }) => r.at.slice(0, 10);
  const before = all.filter(r => from && day(r) < from);
  const opening = before.length ? before[before.length - 1].balance : 0;
  const body = all.filter(r => (!from || day(r) >= from) && day(r) <= upTo);
  const sh = d.shop;
  const rows: (string | number)[][] = [
    [`${st.gstin ? `GSTIN ${st.gstin}` : ''}${st.address ? `${st.gstin ? ' · ' : ''}${st.address}` : ''}`],
    [`To: ${sh.name}${sh.area ? `, ${sh.area}` : ''}${sh.address ? ` · ${sh.address}` : ''}${sh.gstin ? ` · GSTIN ${sh.gstin}` : ''}`],
    [from ? `Period: ${showDate(from)} to ${showDate(upTo)}` : `Period: all entries up to ${showDate(upTo)}`],
    [`Made on ${showDate(now)} · amounts in ₹ (bills include GST)`],
    [],
    ['Date', 'Type', 'Number', 'Debit ₹', 'Credit ₹', 'Balance ₹', 'Note'],
  ];
  if (from) rows.push([showDate(from), 'Opening balance', '', '', '', opening, '']);
  for (const r of body) rows.push([showDate(day(r)), KIND[r.kind], r.ref, r.debit || '', r.credit || '', r.balance, r.note]);
  const closing = body.length ? body[body.length - 1].balance : opening;
  const tDebit = r2(body.reduce((a, r) => a + r.debit, 0)), tCredit = r2(body.reduce((a, r) => a + r.credit, 0));
  rows.push(['', 'Total', '', tDebit, tCredit, closing, from ? `opening ${inr(opening)} + debit − credit` : '']);
  rows.push(['', past ? `Balance as on ${showDate(upTo)}` : 'Balance due', '', '', '', closing, past ? '' : [d.due.overdue > 0 ? `overdue ${inr(d.due.overdue)}` : '', closing < 0 ? 'advance with us' : ''].filter(Boolean).join(' · ')]);
  if (!past && d.pending.length) rows.push(['', 'Cheques not yet due', '', '', '', '', d.pending.map(p => `${p.ref ?? 'cheque'} ${inr(p.amount)} dated ${showDate(p.chequeDate ?? p.date)}`).join('; ')]);
  const title = `${st.firmName} — statement of account: ${sh.name}`;
  await downloadWorkbook(`Statement-${sh.name.replace(/[^\w]+/g, '-')}-${upTo}`, [{ name: 'Statement', header: [title, '', '', '', '', '', ''], rows }]);
  return { rows: body.length, closing };
}
