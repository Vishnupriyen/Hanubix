import { useEffect, useState } from 'react';
import { Check, X, Phone, AlertTriangle, Landmark, MessageSquareText, Download, FileCheck2, ChevronRight, Wallet } from 'lucide-react';
import { ChangeSet, db, today, activeShops, ymd } from '../core/db';
import { moneyPosition, profitAndLoss } from '../core/pnl';
import { inr, showDate, showMonth, plural, showTime } from '../core/i18n';
import { invoiceBalances, OWED, r2 } from '../core/ledger';
import { exportClaims, exportEinvoice, exportGstr1, exportTally } from '../core/exports';
import { downloadWorkbook } from '../core/readers';
import { ask, askText, confirmBox, notify } from './dialog';
import { bounceCheque } from '../core/pipeline';
import { period, salesSummary } from '../core/reports';
import { companyPayables, recordCompanyPayment } from '../core/payables';
import type { BankLine, Expense, Payment } from '../core/types';
import { ShopStatement } from './ShopStatement';

const month = () => today().slice(0, 7);

// ---------- Outstanding by shop and age ----------
export function Outstanding() {
  const [open, setOpen] = useState<string | null>(null);
  const [list, setRows] = useState<{ id: string; name: string; phone?: string; area: string; total: number; b0: number; b8: number; b16: number; b31: number; days: number; late: number; limit: number }[] | null>(null);
  const rows = list ?? [];
  useEffect(() => { (async () => {
    const shops = await activeShops(); const bal = (await invoiceBalances()).filter(b => b.balance > OWED);
    const byShop = new Map<string, typeof bal>(); for (const b of bal) byShop.set(b.invoice.shopId, [...(byShop.get(b.invoice.shopId) ?? []), b]); // grouped once, not 1,200 searches
    setRows(shops.map(s => { const mine = byShop.get(s.id) ?? []; const age = (b: typeof mine[0]) => Math.floor((Date.now() - new Date(b.invoice.date).getTime()) / 86400000); const sum = (f: (d: number) => boolean) => r2(mine.filter(b => f(age(b))).reduce((a, b) => a + b.balance, 0)); return { id: s.id, name: s.name, phone: s.phone, area: s.area, total: r2(mine.reduce((a, b) => a + b.balance, 0)), b0: sum(d => d <= 7), b8: sum(d => d > 7 && d <= 15), b16: sum(d => d > 15 && d <= 30), b31: sum(d => d > 30), days: Math.max(0, ...mine.map(age)), late: Math.max(0, ...mine.map(b => b.overdueDays)), limit: s.creditLimit }; }).filter(r => r.total > OWED).sort((a, b) => b.late - a.late || b.days - a.days || b.total - a.total));
  })(); }, []);
  const tot = (k: 'b0' | 'b8' | 'b16' | 'b31') => r2(rows.reduce((a, r) => a + r[k], 0));
  if (open) return <ShopStatement shopId={open} onBack={() => setOpen(null)} />;
  if (!list) return <div className="card muted">{'Loading…'}</div>; // never "₹0 in the market" before the numbers are in
  return (
    <div className="stack">
      <div className="kpi navy"><div className="v">{inr(rows.reduce((a, r) => a + r.total, 0))}</div><div className="l">{'in the market'} · {plural(rows.length, 'shop')}</div></div>
      <div className="kpis"><div className="kpi"><div className="v">{inr(tot('b0'))}</div><div className="l">0–7 {'days'}</div></div><div className="kpi"><div className="v">{inr(tot('b8'))}</div><div className="l">8–15</div></div><div className="kpi"><div className="v" style={{ color: 'var(--warn)' }}>{inr(tot('b16'))}</div><div className="l">16–30</div></div><div className="kpi"><div className="v" style={{ color: 'var(--bad)' }}>{inr(tot('b31'))}</div><div className="l">30+</div></div></div>
      <div className="list">{rows.map(r => <button key={r.id} className="item tap" onClick={() => setOpen(r.id)}><div className={`avatar ${r.late > 30 ? 'bad' : r.late > 15 ? 'gold' : ''}`}>{r.name[0]}</div><div className="grow" style={{ textAlign: 'left' }}><div className="t">{r.name}</div><div className="s">{r.area} · {r.late > 0 ? `${r.late} days late` : 'not late yet'}{r.limit && r.total > r.limit ? ' · ' : ''}{r.limit > 0 && r.total > r.limit && <span className="badge bad">{'over limit'}</span>}</div></div><span className="amt num">{inr(r.total)}</span>{r.phone && <a className="btn small" href={`tel:${r.phone}`} onClick={e => e.stopPropagation()} aria-label="Call"><Phone size={16} /></a>}</button>)}</div>
      <div className="muted">{'Tap a shop for its full statement.'}</div>
    </div>
  );
}

// ---------- Cheques & UPI: today's non-cash, references, cleared/bounced; duplicate alerts ----------
export function Cheques() {
  const [rows, setRows] = useState<(Payment & { shop: string; by: string; bills: string })[]>([]);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { (async () => { const shops = new Map((await activeShops()).map(s => [s.id, s.name])); const staff = new Map((await db.staff.toArray()).map(s => [s.id, s.name])); const inv = new Map((await db.invoices.toArray()).map(i => [i.id, i.number])); setRows((await db.payments.toArray()).filter(p => p.mode !== 'cash' && p.status !== 'cancelled').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60).map(p => ({ ...p, shop: shops.get(p.shopId) ?? '', by: staff.get(p.collectedBy) ?? '', bills: p.allocations.map(a => inv.get(a.invoiceId) ?? '').filter(Boolean).join(', ') }))); })(); }, [tick]);
  const dup = (p: Payment) => rows.some(q => q.id !== p.id && q.shopId === p.shopId && q.amount === p.amount && q.date === p.date);
  const setRef = async (p: Payment) => { const r = await askText('Reference number', p.ref ?? ''); if (!r) return; const cs = new ChangeSet(); cs.put('payments', { ...p, ref: r }, 'reference'); await cs.commit('Reference'); setTick(x => x + 1); };
  const bounce = async (p: Payment) => {
    if (!await confirmBox(`Cheque of ${inr(p.amount)} from ${(p as Payment & { shop: string }).shop} bounced?`, 'The bills it paid open again and the shop owes this money again.', 'Yes, bounced')) return;
    const why = await askText('Why did it bounce?', 'Funds insufficient'); if (!why) return;
    try { await bounceCheque(p.id, why); } catch (e) { await notify('Not saved', (e as Error).message); }
    setTick(x => x + 1);
  };
  if (open) return <ShopStatement shopId={open} onBack={() => setOpen(null)} />;
  return (
    <div className="stack">
      <div className="list">
        {rows.map(p => <div key={p.id} className="item" style={{ flexWrap: 'wrap' }}>
          <div className={`avatar ${p.status === 'bounced' ? 'bad' : !p.ref && !p.confirmPhoto ? 'gold' : 'ok'}`}>{p.mode === 'upi' ? 'U' : 'C'}</div>
          <div className="grow"><div className="t"><button className="link" style={{ fontSize: 'var(--f3)', fontWeight: 700, padding: 0 }} onClick={() => setOpen(p.shopId)}>{p.shop}</button> · {inr(p.amount)}</div><div className="s">{showDate(p.date)} {showTime(p.createdAt)} · {p.mode.toUpperCase()} {p.ref || <span className="badge warn">{'no reference'}</span>} · {'bills'} {p.bills ? p.bills.split(/,\s*/).map((b, i) => <span key={b + i}>{i ? ', ' : ''}<span className="billno">{b}</span></span>) : '—'} · {'by'} {p.by}{p.status === 'bounced' ? ' · ' : ''}{p.status === 'bounced' && <span className="badge bad">{'bounced'}{p.bounce?.reason ? `: ${p.bounce.reason}` : ''}</span>}{p.mode === 'cheque' && p.chequeDate && p.chequeDate > today() && <span className="badge warn" style={{ marginLeft: 6 }}>{'dated'} {showDate(p.chequeDate)}</span>}{dup(p) && <span className="badge bad" style={{ marginLeft: 6 }}><AlertTriangle size={11} /> {'same amount twice'}</span>}</div></div>
          {!p.ref && <button className="btn small" onClick={() => setRef(p)}>{'Add ref'}</button>}
          {p.mode === 'cheque' && p.status !== 'bounced' && <button className="btn small" onClick={() => bounce(p)}><X size={14} /> {'Bounced'}</button>}
          {p.confirmPhoto && <img src={p.confirmPhoto} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }} />}
        </div>)}
        {!rows.length && <div className="card muted">{'No UPI or cheque payments yet.'}</div>}
      </div>
    </div>
  );
}

// ---------- Bank: statement comes through TESRAX chat; this shows what's matched and what isn't ----------
export function Bank({ onRox }: { onRox?: () => void }) {
  const [lines, setLines] = useState<(BankLine & { shop?: string })[]>([]);
  useEffect(() => { (async () => { const shops = new Map((await activeShops()).map(s => [s.id, s.name])); setLines((await db.bankLines.toArray()).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60).map(b => ({ ...b, shop: b.shopId ? shops.get(b.shopId) : undefined }))); })(); }, []);
  const un = lines.filter(l => l.status === 'unmatched');
  return (
    <div className="stack">
      <button className="btn primary big block" onClick={onRox}><MessageSquareText /> {'Drop the statement in TESRAX → "match this"'}</button>
      <div className="muted">{'Upload daily or weekly — only new lines are matched; the same line is never counted twice.'}</div>
      <div className="kpis"><div className="kpi"><div className="v">{lines.filter(l => l.status === 'matched').length}</div><div className="l">{'matched'}</div></div><div className="kpi"><div className="v" style={{ color: un.length ? 'var(--warn)' : undefined }}>{un.length}</div><div className="l">{'to check'}</div></div></div>
      <div className="list">{lines.map(l => <div key={l.id} className="item"><div className={`avatar ${l.status === 'matched' ? 'ok' : l.status === 'ignored' ? '' : 'gold'}`}><Landmark size={18} /></div><div className="grow"><div className="t">{l.shop ?? l.narration.slice(0, 40)}</div><div className="s">{showDate(l.date)}{l.ref ? ` · ${l.ref}` : ''} · {l.status}</div></div><span className="amt num" style={{ color: l.debit ? 'var(--bad)' : undefined }}>{l.credit ? inr(l.credit) : `−${inr(l.debit)}`}</span></div>)}{!lines.length && <div className="card muted">{'No statement uploaded yet.'}</div>}</div>
    </div>
  );
}

// ---------- Expenses: entered by chat; owner approves in bulk; by head and by van ----------
export function Expenses({ onRox }: { onRox?: () => void }) {
  const [rows, setRows] = useState<(Expense & { van?: string })[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => { (async () => { const vans = new Map((await db.vans.toArray()).map(v => [v.id, v.name])); setRows((await db.expenses.toArray()).filter(e => e.date.startsWith(month())).sort((a, b) => b.date.localeCompare(a.date)).map(e => ({ ...e, van: e.vanId ? vans.get(e.vanId) : undefined }))); })(); }, [tick]);
  const pending = rows.filter(e => !e.approved && e.category !== 'advance');
  const approveAll = async () => { const cs = new ChangeSet(); for (const e of pending) cs.put('expenses', { ...e, approved: true }, 'approved'); await cs.commit('Expenses approved'); setTick(x => x + 1); };
  const byCat = new Map<string, number>(); for (const e of rows) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount);
  return (
    <div className="stack">
      <button className="btn primary big block" onClick={onRox}><MessageSquareText /> {'Tell TESRAX: "diesel 1500", "toll 80", "rent 12000"'}</button>
      <div className="kpi navy"><div className="v">{inr(rows.reduce((a, e) => a + e.amount, 0))}</div><div className="l">{'this month'}{byCat.size ? ' · ' : ''}{[...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${inr(v)}`).join(' · ')}</div></div>
      {pending.length > 0 && <div className="alert"><Wallet /><div className="grow"><b>{pending.length} {'to approve'}</b> · {inr(pending.reduce((a, e) => a + e.amount, 0))}</div><button className="btn small primary" onClick={approveAll}><Check /> {'Approve all'}</button></div>}
      <div className="list">{rows.map(e => <div key={e.id} className="item"><div className={`avatar ${e.approved || e.category === 'advance' ? 'ok' : 'gold'}`}><Wallet size={18} /></div><div className="grow"><div className="t">{e.category}{e.van ? ` · ${e.van}` : ''}</div><div className="s">{showDate(e.date)} · {e.note?.slice(0, 50)}</div></div><span className="amt num">{inr(e.amount)}</span>{!e.approved && e.category !== 'advance' && <button className="btn small" onClick={async () => { const cs = new ChangeSet(); cs.put('expenses', { ...e, approved: true }, 'approved'); await cs.commit('Expense approved'); setTick(x => x + 1); }}><Check size={14} /></button>}</div>)}</div>
    </div>
  );
}

// ---------- P&L: the owner's most important screen ----------
export function PnL() {
  type Head = { key: string; label: string; amount: number; items: { d: string; t: string; v: number }[] };
  const [d, setD] = useState<{ income: Head[]; expense: Head[]; cash: number; bank: number; staff: number } | null>(null);
  const [period, setPeriod] = useState<'today' | 'month'>('month');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void profitAndLoss(period).then(setD); }, [period]);
  if (!d) return null;
  const incT = r2(d.income.reduce((a, h) => a + h.amount, 0)); const expT = r2(d.expense.reduce((a, h) => a + h.amount, 0)); const profit = r2(incT - expT);
  const HeadRow = ({ h, neg }: { h: Head; neg?: boolean }) => (
    <div>
      <button className="row" style={{ justifyContent: 'space-between', minHeight: 38, width: '100%', background: 'none', border: 0, padding: 0, textAlign: 'left' }} onClick={() => setOpen(open === h.key ? null : h.key)}>
        <span>{h.label} <span className="muted">· {h.items.length}</span></span><span className="num" style={{ color: neg ? 'var(--bad)' : (h.amount < 0 ? 'var(--bad)' : undefined) }}>{neg ? '− ' : ''}{inr(Math.abs(h.amount))}</span>
      </button>
      {open === h.key && <div className="list" style={{ marginBottom: 8 }}>{h.items.slice(0, 60).map((it, i) => <div key={i} className="item" style={{ minHeight: 36 }}><div className="grow"><div className="s">{it.d.slice(5)} · {it.t}</div></div><span className="num">{inr(Math.abs(it.v))}</span></div>)}{h.items.length > 60 && <div className="muted">+{h.items.length - 60} more</div>}</div>}
    </div>
  );
  return (
    <div className="stack">
      <div className="segmented" style={{ maxWidth: 260 }}><button className={period === 'today' ? 'on' : ''} onClick={() => setPeriod('today')}>{'Today'}</button><button className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')}>{'This month'}</button></div>
      <div className="kpi navy"><div className="v" style={{ color: profit < 0 ? 'var(--bad)' : undefined }}>{inr(profit)}</div><div className="l">{'net profit'} · {incT ? Math.round(profit / incT * 100) : 0}% · {'tap a head to see entries'}</div></div>
      <div className="card">
        <div className="eyebrow">{'Income'}</div>
        {d.income.map(h => <HeadRow key={h.key} h={h} />)}
        <div className="row" style={{ justifyContent: 'space-between', minHeight: 36, fontWeight: 800, borderTop: '1px solid var(--line)' }}><span>{'Total income'}</span><span className="num">{inr(incT)}</span></div>
      </div>
      <div className="card">
        <div className="eyebrow">{'Expenses'}</div>
        {d.expense.map(h => <HeadRow key={h.key} h={h} neg />)}
        <div className="row" style={{ justifyContent: 'space-between', minHeight: 36, fontWeight: 800, borderTop: '1px solid var(--line)' }}><span>{'Total expenses'}</span><span className="num" style={{ color: 'var(--bad)' }}>− {inr(expT)}</span></div>
        <div className="row" style={{ justifyContent: 'space-between', minHeight: 36, fontWeight: 800, borderTop: '2px solid var(--ink)' }}><span>{'Net profit'}</span><span className="num">{inr(profit)}</span></div>
      </div>
      <div className="kpis"><div className="kpi"><div className="v">{inr(d.cash)}</div><div className="l">{'cash in hand now'}</div></div><div className="kpi"><div className="v">{inr(d.bank)}</div><div className="l">{'in bank now'}</div></div><div className="kpi"><div className="v" style={{ color: d.staff ? 'var(--warn)' : undefined }}>{inr(d.staff)}</div><div className="l">{'with staff now'}</div></div></div>
      <div className="muted">{'Sales here are before GST and after returns — the same as Reports and GST. Money figures are what you have now, the same as Cash flow.'}</div>
    </div>
  );
}

// ---------- Cash flow: what comes in, what goes out, when ----------
export function CashFlow({ go }: { go?: (p: string) => void }) {
  type Line = { name: string; amount: number; sub: string; id?: string };
  const [d, setD] = useState<{ cash: number; bank: number; staff: number; recv: Line[]; recvOverdue: number; payCo: Line[]; cheques: Line[]; claims: number; loans: number } | null>(null);
  const [openShop, setOpenShop] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { (async () => {
    const shops = new Map((await db.shops.toArray()).map(s => [s.id, s.name]));
    const cos = new Map((await db.companies.toArray()).map(c => [c.id, c.name]));
    const bal = (await invoiceBalances()).filter(b => b.balance > OWED);
    const byShop = new Map<string, { amount: number; overdue: number; n: number }>();
    for (const b of bal) { const v = byShop.get(b.invoice.shopId) ?? { amount: 0, overdue: 0, n: 0 }; v.amount += b.balance; v.n++; if (b.overdueDays > 0) v.overdue += b.balance; byShop.set(b.invoice.shopId, v); }
    const recv: Line[] = [...byShop.entries()].map(([id, v]) => ({ id, name: shops.get(id) ?? id, amount: r2(v.amount), sub: `${plural(v.n, 'bill')}${v.overdue ? ` · ${'overdue'} ${inr(r2(v.overdue))}` : ''}` })).sort((a, b) => b.amount - a.amount);
    // payables = company bills − payments made − company credit notes
    const payCo: Line[] = [...(await companyPayables()).entries()].filter(([, v]) => v.due > 0.5).map(([id, v]) => ({ id, name: cos.get(id) ?? id, amount: v.due, sub: `${v.bills} ${'company bills'} · ${'oldest'} ${v.oldest.slice(5)}${v.paid ? ` · paid ${inr(v.paid)}` : ''}${v.credited ? ` · credit notes ${inr(v.credited)}` : ''}` })).sort((a, b) => b.amount - a.amount);
    const pays = (await db.payments.toArray());
    const cheques: Line[] = pays.filter(p => p.mode === 'cheque' && p.status !== 'cancelled' && !p.bankLineId).map(p => ({ id: p.shopId, name: shops.get(p.shopId) ?? '', amount: p.amount, sub: `${p.ref ?? ''} · ${showDate(p.date)}${p.status === 'bounced' ? ' · ' + 'BOUNCED' : ''}` }));
    const exps = await db.expenses.toArray();
    const claims = r2((await db.claims.toArray()).filter(c => ['submitted', 'approved'].includes(c.status)).reduce((a, c) => a + c.amount - (c.received ?? 0), 0));
    const pos = await moneyPosition(); // the same cash, bank and staff cash as the P&L screen
    setD({ cash: pos.cash, bank: pos.bank, staff: pos.staff, recv, recvOverdue: r2(bal.filter(b => b.overdueDays > 0).reduce((a, b) => a + b.balance, 0)), payCo, cheques, claims, loans: r2(exps.filter(e => e.category === 'loan').reduce((a, e) => a + e.amount, 0)) });
  })(); }, [tick]);
  // record a payment made to a company, or a credit note it sent (claim settled), against its oldest bills
  const payCompany = async (l: Line) => {
    if (!l.id) return;
    const kind = await ask(`${l.name} · you owe ${inr(l.amount)}`, { choices: [{ label: 'Payment made', value: 'payment' }, { label: 'Credit note received', value: 'credit_note' }] }) as 'payment' | 'credit_note' | null; if (!kind) return;
    const amount = Number(await askText('Amount ₹', String(l.amount), 'number')); if (!amount) return;
    const ref = await askText(kind === 'payment' ? 'UTR / cheque no' : 'Company credit note no', ''); if (ref === null) return;
    try { await recordCompanyPayment({ companyId: l.id, amount, kind, ref, mode: kind === 'payment' ? 'bank' : undefined }); setTick(x => x + 1); } catch (e) { await notify('Not saved', (e as Error).message); }
  };
  if (openShop) return <ShopStatement shopId={openShop} onBack={() => setOpenShop(null)} />;
  if (!d) return null;
  const recvT = r2(d.recv.reduce((a, l) => a + l.amount, 0)); const payT = r2(d.payCo.reduce((a, l) => a + l.amount, 0)); const chqT = r2(d.cheques.reduce((a, l) => a + l.amount, 0));
  const have = r2(d.cash + d.bank + d.staff); const net = r2(have + recvT + chqT + d.claims - payT);
  const Sec = ({ title, total, lines, tone, onTap }: { title: string; total: number; lines: Line[]; tone?: string; onTap?: (l: Line) => void }) => (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}><div className="eyebrow">{title}</div><b className="num" style={{ color: tone }}>{inr(total)}</b></div>
      <div className="list">{lines.slice(0, 12).map((l, i) => <button key={i} className="item tap" onClick={() => onTap?.(l)} disabled={!onTap}><div className="grow" style={{ textAlign: 'left' }}><div className="t">{l.name}</div><div className="s">{l.sub}</div></div><span className="amt num">{inr(l.amount)}</span></button>)}{lines.length > 12 && <div className="muted">+{lines.length - 12} more</div>}</div>
    </div>
  );
  return (
    <div className="stack">
      <div className="kpi navy"><div className="v">{inr(have)}</div><div className="l">{'money I have now'} · {'cash'} {inr(d.cash)} · {'bank'} {inr(d.bank)} · {'with staff'} {inr(d.staff)}</div></div>
      <div className="kpis">
        <div className="kpi"><div className="v" style={{ color: 'var(--ok)' }}>{inr(recvT + chqT + d.claims)}</div><div className="l">{'coming in'}{d.recvOverdue ? ` · ${inr(d.recvOverdue)} ${'overdue'}` : ''}</div></div>
        <div className="kpi"><div className="v" style={{ color: 'var(--bad)' }}>{inr(payT + d.loans)}</div><div className="l">{'going out'}</div></div>
      </div>
      <div className="muted">{'If everyone pays and I pay everyone'}: <b className="num" style={{ color: net < 0 ? 'var(--bad)' : 'var(--ok)' }}>{inr(net)}</b></div>
      <Sec title={'Receivables from shops'} total={recvT} lines={d.recv} tone="var(--ok)" onTap={l => l.id && setOpenShop(l.id)} />
      <Sec title={'Pending cheques'} total={chqT} lines={d.cheques} onTap={() => go?.('cheques')} />
      <Sec title={'Payables to companies'} total={payT} lines={d.payCo} tone="var(--bad)" onTap={l => void payCompany(l)} />
      <div className="card"><div className="row" style={{ justifyContent: 'space-between' }}><span>{'Claims to receive'}</span><b className="num">{inr(d.claims)}</b></div><div className="row" style={{ justifyContent: 'space-between' }}><span>{'Loans'}</span><b className="num">{inr(d.loans)}</b></div></div>
      <div className="muted">{'Ask TESRAX: "who will pay this week", "what do I owe Britannia", "cash flow".'}</div>
    </div>
  );
}

// ---------- Export: Tally, Excel ledgers ----------
export function ExportPage() {
  const m = month();
  const run = async (f: () => Promise<{ text: string }>) => { const r = await f(); void notify('Export', r.text); };
  const ledgers = async () => {
    const shops = new Map((await activeShops()).map(s => [s.id, s.name]));
    const invs = (await db.invoices.toArray()).filter(i => !i.cancelled && i.date.startsWith(m)); const pays = (await db.payments.toArray()).filter(p => p.date.startsWith(m) && p.status === 'ok'); const exps = (await db.expenses.toArray()).filter(e => e.date.startsWith(m));
    await downloadWorkbook(`Hanubix-ledgers-${m}`, [
      { name: 'Sales', header: ['Date', 'Bill', 'Shop', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'], rows: invs.map(i => [i.date, i.number, shops.get(i.shopId) ?? '', i.taxable, i.cgst, i.sgst, i.igst, i.total]) },
      { name: 'Receipts', header: ['Date', 'Shop', 'Mode', 'Ref', 'Amount'], rows: pays.map(p => [p.date, shops.get(p.shopId) ?? '', p.mode, p.ref ?? '', p.amount]) },
      { name: 'Expenses', header: ['Date', 'Head', 'Amount', 'Note'], rows: exps.map(e => [e.date, e.category, e.amount, e.note ?? '']) },
    ]);
  };
  return (
    <div className="stack">
      <button className="btn big block" onClick={() => run(() => exportTally(m))}><Download /> {'Tally XML'} · {showMonth(m)}</button>
      <button className="btn big block" onClick={ledgers}><Download /> {'Excel ledgers (sales, receipts, expenses)'}</button>
      <button className="btn big block" onClick={() => run(() => exportClaims(m))}><Download /> {'Claim file'}</button>
      <div className="muted">{'Your auditor gets these monthly. GST files are under the GST icon.'}</div>
    </div>
  );
}

// ---------- GST: TESRAX acts as the accountant; one screen, flags with one-tap fixes ----------
export function Gst({ go }: { go?: (p: string) => void }) {
  const [d, setD] = useState<{ sales: number; tax: number; bills: number; flags: { text: string; page?: string; tone?: 'bad' }[]; due: string; daysLeft: number } | null>(null);
  const m = month();
  useEffect(() => { (async () => {
    const invs = (await db.invoices.toArray()).filter(i => !i.cancelled && i.date.startsWith(m));
    const products = await db.products.toArray(); const shops = await activeShops();
    const flags: { text: string; page?: string; tone?: 'bad' }[] = [];
    const noHsn = products.filter(p => p.active && !(p.hsn && (p.hsn.length === 6 || p.hsn.length === 8)));
    if (noHsn.length) flags.push({ text: `${plural(noHsn.length, 'product')} have no valid HSN: ${noHsn.slice(0, 3).map(p => p.name).join(', ')} — fix before filing`, tone: 'bad' });
    const revised = invs.filter(i => i.original);
    if (revised.length) flags.push({ text: `${plural(revised.length, 'bill')} revised after delivery — included as delivered quantities, originals kept inside`, page: 'status' });
    const badGst = shops.filter(s => s.gstin && s.gstin.length !== 15);
    if (badGst.length) flags.push({ text: `${plural(badGst.length, 'shop')} have a wrong GSTIN — billed as B2C until fixed`, page: 'outstanding' });
    const purchases = (await db.purchases.toArray()).filter(p => p.date.startsWith(m));
    if (purchases.length) flags.push({ text: `${plural(purchases.length, 'company bill')} this month — drop your GSTR-2B Excel in TESRAX ("match 2B") before claiming input credit` });
    const turnover = (await db.invoices.toArray()).filter(i => !i.cancelled).reduce((a, i) => a + i.total, 0);
    if (turnover > 50000000) flags.push({ text: 'Turnover crossed ₹5 crore — e-invoicing is mandatory', tone: 'bad' });
    const next = new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 11); const daysLeft = Math.ceil((next.getTime() - Date.now()) / 86400000);
    // the month's sales net of credit notes: the same figure as Reports and GSTR-1 (core/reports.ts)
    const net = await salesSummary(period('month'));
    setD({ sales: net.net.taxable, tax: net.tax, bills: invs.length, flags, due: ymd(next), daysLeft });
  })(); }, []);
  if (!d) return null;
  const run = async (f: () => Promise<{ text: string }>) => { const r = await f(); void notify('GST', r.text); };
  return (
    <div className="stack">
      <div className="card" style={{ background: 'var(--navy)', color: 'var(--on-navy)' }}>
        <div className="eyebrow" style={{ color: 'var(--on-navy-2)' }}>{showMonth(m)}</div>
        <div style={{ fontSize: 'var(--f4)', lineHeight: 1.5 }}>{`Sales before GST, after returns: ${inr(d.sales)} on ${plural(d.bills, 'bill')} · tax to pay ${inr(d.tax)} · ${d.flags.length ? `${d.flags.length} ${d.flags.length === 1 ? 'thing' : 'things'} to fix` : 'nothing to fix'} · file GSTR-1 by ${showDate(d.due)} (${d.daysLeft} days).`}</div>
      </div>
      {d.flags.map((f, i) => <button key={i} className={`flag ${f.tone ?? ''}`} onClick={() => f.page && go?.(f.page)} style={{ textAlign: 'left' }}><AlertTriangle style={{ color: f.tone === 'bad' ? 'var(--bad)' : 'var(--warn)', flex: 'none' }} /><span className="grow">{f.text}</span>{f.page && <ChevronRight />}</button>)}
      {!d.flags.length && <div className="alert ok"><Check /><div>{'Everything is in order for filing.'}</div></div>}
      <div className="card stack">
        <div className="eyebrow"><FileCheck2 size={14} style={{ verticalAlign: -2 }} /> {'Ready for auditor'}</div>
        <button className="btn big block" onClick={() => run(() => exportGstr1(m))}><Download /> GSTR-1 ({'portal format'})</button>
        <button className="btn big block" onClick={() => run(() => exportEinvoice(m))}><Download /> {'E-invoice JSON (NIC)'}</button>
        <div className="muted">{'3B summary: output tax'} {inr(d.tax)} {'minus input credit after 2B match.'}</div>
      </div>
    </div>
  );
}
