import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Repeat, Search, Flame, Gift, AlertTriangle, Check } from 'lucide-react';
import { ChangeSet, db, session, today, daysFrom } from '../core/db';
import { activeSchemes, applySchemes, allStock } from '../core/billing';
import { bookOrder, updateMyOrder } from '../core/pipeline';
import { askText, confirmBox } from './dialog';
import { useBack } from './useBack';
import { OWED, r2, shopOutstanding } from '../core/ledger';
import { norm } from '../core/match';
import { inr, t, plural } from '../core/i18n';
import type { Order, Company, Product, Role, Scheme, Shop, Visit, Invoice } from '../core/types';
import { Pack } from './Pack';
import { PrintBill } from './PrintBill';

interface Line { product: Product; cases: number; pcs: number; rate?: number }

// Salesman order booking (4.1, 5.1, Q91, Q93, Q94): pictures first, push list, live stock, dues
// and scheme shown, case + piece steppers, repeat last order. Under a minute per shop.
export function OrderBook({ shop, visit, onClose, existing }: { shop: Shop; visit?: Visit; onClose: () => void; existing?: Order }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'push' | 'usual' | 'all' | string>('push');
  const [due, setDue] = useState({ total: 0, overdue: 0 });
  const [usual, setUsual] = useState<Set<string>>(new Set());
  const [lastOrder, setLastOrder] = useState<{ productId: string; qty: number }[]>([]);
  const [result, setResult] = useState<{ text: string; invoices: Invoice[]; needsOk: boolean } | null>(null);
  const [issuesText, setIssuesText] = useState('');
  const [remark, setRemark] = useState('');
  const [printing, setPrinting] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => { db.staff.get(session().userId).then(s => setRole(s?.role ?? null)); }, []);
  // back (arrow or phone) goes to the beat; an order with lines asks first, so a half-typed order is never lost silently
  const leave = async () => {
    const n = Object.keys(lines).length;
    if (!result && n && !(await confirmBox('Leave this order?', `${plural(n, 'line')} will be lost.`, 'Leave'))) return;
    onClose();
  };
  useBack(() => { void leave(); return true; });
  const field = role === 'salesman' || role === 'rep'; // field staff send the order; the owner and office approve it

  useEffect(() => {
    (async () => {
      const ps = (await db.products.toArray()).filter(p => p.active);
      // what this shop usually buys first (the salesman's first tap), then stock in one read, then dues
      const past = (await db.orders.where('shopId').equals(shop.id).toArray()).filter(x => x.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date));
      const u = new Set<string>(); for (const o2 of past.slice(0, 6)) for (const l of o2.lines) u.add(l.productId);
      setUsual(u);
      setLastOrder(past[0]?.lines ?? []);
      setProducts(ps); setCompanies(await db.companies.toArray()); setSchemes(await db.schemes.toArray());
      setStock(Object.fromEntries(await allStock()));
      const o = await shopOutstanding(shop.id); setDue({ total: o.total, overdue: o.overdue });
      if (existing) { const pm = new Map(ps.map(p => [p.id, p])); const init: Record<string, Line> = {}; for (const l of existing.lines) { const p = pm.get(l.productId); if (p) init[p.id] = { product: p, cases: Math.floor(l.qty / p.caseSize), pcs: l.qty % p.caseSize, rate: l.rate !== p.rate ? l.rate : undefined }; } setLines(init); setCat('all'); }
    })();
  }, [shop.id]);

  const nearExpiry = useMemo(() => new Set<string>(), []);
  useEffect(() => { db.batches.toArray().then(bs => { const lim = daysFrom(45); for (const b of bs) if (b.qty > 0 && b.expiry <= lim) nearExpiry.add(b.productId); }); }, [nearExpiry]);

  const shown = useMemo(() => {
    let list = products;
    if (q) list = list.filter(p => norm(p.name).includes(norm(q)) || p.aliases.some(a => norm(a).includes(norm(q))));
    else if (cat === 'push') list = list.filter(p => p.focus || nearExpiry.has(p.id));
    else if (cat === 'usual') list = list.filter(p => usual.has(p.id));
    else if (cat !== 'all') list = list.filter(p => p.companyId === cat);
    return list.sort((a, b) => (usual.has(b.id) ? 1 : 0) - (usual.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
  }, [products, q, cat, usual, nearExpiry]);

  const setQty = (p: Product, cases: number, pcs: number) => {
    cases = Math.max(0, cases); pcs = Math.max(0, pcs);
    if (pcs >= p.caseSize) { cases += Math.floor(pcs / p.caseSize); pcs = pcs % p.caseSize; }
    setLines(ls => { const n = { ...ls }; if (!cases && !pcs) delete n[p.id]; else n[p.id] = { product: p, cases, pcs }; return n; });
  };
  const pieces = (l: Line) => l.cases * l.product.caseSize + l.pcs;
  const lineInfo = (l: Line) => {
    const qty = pieces(l);
    const sch = applySchemes(l.product, qty, l.rate ?? l.product.rate, activeSchemes(schemes, l.product, today()));
    return { qty, free: sch.freeQty, amount: r2((sch.gross - sch.discount) * (1 + l.product.gst / 100)), schemeNames: sch.names, short: Math.max(0, qty + sch.freeQty - (stock[l.product.id] ?? 0)) };
  };
  const totals = Object.values(lines).reduce((a, l) => { const i = lineInfo(l); return { items: a.items + 1, amount: r2(a.amount + i.amount), free: a.free + i.free }; }, { items: 0, amount: 0, free: 0 });

  const repeatLast = () => {
    const n: Record<string, Line> = {};
    for (const l of lastOrder) { const p = products.find(x => x.id === l.productId); if (p) n[p.id] = { product: p, cases: Math.floor(l.qty / p.caseSize), pcs: l.qty % p.caseSize }; }
    setLines(n);
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const cs = new ChangeSet();
      const ls = Object.values(lines).map(l => ({ productId: l.product.id, qty: pieces(l), rate: l.rate ?? l.product.rate }));
      const lowered = Object.values(lines).filter(l => l.rate != null && l.rate < l.product.rate);
      if (lowered.length && !remark.trim()) { const r = await askText('Lower rate — write the reason (the owner approves it)'); if (!r) { setBusy(false); return; } setRemark(r); }
      if (existing) { await updateMyOrder(existing.id, ls); setResult({ text: 'Order updated', invoices: [], needsOk: false }); return; }
      const order = await bookOrder(cs, shop, ls, session().userId, { visitId: visit?.id, offRoute: shop.salesmanId !== session().userId, rateRemark: lowered.length ? `${lowered.map(l => `${l.product.name} @${l.rate} (std ${l.product.rate})`).join(', ')} — ${remark}` : undefined });
      if (visit) cs.put('visits', { ...visit, outcome: 'order' }, 'visit outcome');
      await cs.commit('Salesman order');
      setIssuesText(order.issues.map(x => x.replace(/^Overdue (\d+) days \(.*\)$/, 'overdue $1 days')).join('; '));
      setResult({
        text: 'Order sent to the owner',
        invoices: [], needsOk: order.issues.length > 0,
      });
    } finally { setBusy(false); }
  };

  if (result) return (
    <div className="stack" style={{ textAlign: 'center', paddingTop: 30 }}>
      {/* sent is sent: always the green tick; what the owner will look at is the yellow line under it */}
      <div className="avatar ok" style={{ width: 96, height: 96, margin: '0 auto', borderRadius: 28 }}><Check size={56} /></div>
      <h2>{result.text}</h2>
      <div className="muted">{shop.name} · {plural(totals.items, 'item')} · {inr(totals.amount)}</div>
      {result.needsOk && <div className="alert" style={{ textAlign: 'left' }}><AlertTriangle /><div>{'Owner will check: '}{issuesText}</div></div>}
      {result.invoices.length > 0 && <div className="row" style={{ justifyContent: 'center' }}>{result.invoices.map(i => <button key={i.id} className="btn small" onClick={() => setPrinting(i)}><span className="billno">{i.number}</span> · {inr(i.total)}</button>)}</div>}
      <button className="btn big primary block" onClick={onClose}>{'Next shop'} →</button>
      {printing && <PrintBill invoice={printing} onClose={() => setPrinting(null)} />}
    </div>
  );

  return (
    <div className="stack" style={{ paddingBottom: 0 }}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <button className="icon-btn" onClick={() => void leave()} aria-label="Back"><ArrowLeft /></button>
        <div className="grow"><div className="h">{shop.name}</div><div className="muted">{shop.area}{shop.owner ? ` · ${shop.owner}` : ''}</div></div>
        {lastOrder.length > 0 && <button className="btn small" onClick={repeatLast}><Repeat /> {'Repeat last'}</button>}
      </div>
      {due.total > OWED && (
        <div className={`alert ${due.overdue > 0 ? 'bad' : ''}`} style={{ padding: '8px 12px' }}>
          <AlertTriangle />
          <div style={{ minWidth: 0 }}><b>{inr(due.total)} {'pending'}</b>{due.overdue > 0 && <> · <b style={{ color: 'var(--bad)' }}>{inr(due.overdue)}</b> {'overdue'}</>}<div className="muted">{shop.creditLimit > 0 ? `${'Credit limit'} ${inr(shop.creditLimit)} · ${shop.creditDays} ${'days'}` : ''}</div></div>
        </div>
      )}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <div className="field grow" style={{ position: 'relative' }}>
          <Search size={18} style={{ position: 'absolute', left: 12, top: 14, color: 'var(--ink-3)' }} />
          <input id="order-search" value={q} onChange={e => setQ(e.target.value)} placeholder={'Search product…'} style={{ paddingLeft: 38 }} />
        </div>
      </div>
      <div className="cat">
        {[['push', 'Push list'], ['usual', 'Usual'], ['all', 'All'], ...companies.map(c => [c.id, c.code])].map(([k, l]) => (
          <button key={k} className={`chip ${cat === k ? 'on' : ''}`} style={cat === k ? { background: 'var(--navy)', color: 'var(--on-navy)', borderColor: 'var(--navy)' } : undefined} onClick={() => { setCat(k); setQ(''); }}>{l}</button>
        ))}
      </div>
      <div className="list">
        {shown.map(p => {
          const l = lines[p.id];
          const info = l ? lineInfo(l) : null;
          const sch = activeSchemes(schemes, p, today());
          const st = stock[p.id] ?? 0;
          return (
            <div key={p.id} className="item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
              <div className="row" style={{ flexWrap: 'nowrap', width: '100%' }}>
                <Pack product={p} />
                <div className="grow">
                  <div className="t">{p.name}</div>
                  <div className="s">MRP {p.mrp} · {inr(p.rate)}/pc · {p.caseSize}/case</div>
                  <div className="row" style={{ marginTop: 4 }}>
                    {p.focus && <span className="badge gold"><Flame size={12} /> focus</span>}
                    {nearExpiry.has(p.id) && <span className="badge warn">clear stock</span>}
                    {sch.map(s => <span key={s.id} className="badge ok"><Gift size={12} /> {s.type === 'pct' ? `${s.value}% off` : `${s.buyQty}+${s.freeQty} free`}</span>)}
                    <span className={`badge ${st <= 0 ? 'bad' : st < p.caseSize ? 'warn' : ''}`}>{st <= 0 ? ('no stock') : `${Math.floor(st / p.caseSize)} cs ${st % p.caseSize ? `+${st % p.caseSize}` : ''}`}</span>
                  </div>
                </div>
              </div>
              <div className="row" style={{ width: '100%', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
                  <div><div className="eyebrow">{'Cases'}</div><Stepper value={l?.cases ?? 0} onChange={v => setQty(p, v, l?.pcs ?? 0)} /></div>
                  <div><div className="eyebrow">{'Pcs'}</div><Stepper value={l?.pcs ?? 0} onChange={v => setQty(p, l?.cases ?? 0, v)} /></div>
                </div>
                {l && pieces(l) > 0 && <button className="link" style={{ fontSize: 'var(--f1)' }} onClick={async () => { const r = await askText(`${p.name}: ${'rate per piece'} (std ${inr(p.rate)})`, String(l.rate ?? p.rate), 'number'); if (r === null) return; const v = Number(r); if (!v) return; setLines(ls => ({ ...ls, [p.id]: { ...ls[p.id], rate: v } })); }}>{inr(l.rate ?? p.rate)}{l.rate != null && l.rate < p.rate ? ' ↓' : ''}</button>}
                {info && <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
                  {info.free > 0 && <span className="badge ok">+{info.free} free</span>}
                  {info.short > 0 && <span className="badge bad">{info.short} short</span>}
                  <span className="amt num">{inr(info.amount)}</span>
                </div>}
              </div>
            </div>
          );
        })}
        {!shown.length && <div className="card muted">{'Nothing here'}</div>}
      </div>
      <div className="sticky-foot">
        <div className="grow"><div className="eyebrow">{plural(totals.items, 'item')}{totals.free ? ` · ${totals.free} free` : ''}</div><div className="amt num" style={{ fontSize: 'var(--f5)' }}>{inr(totals.amount)}</div></div>
        <button className="btn primary big" disabled={!totals.items || busy} onClick={confirm}><Check /> {field ? 'Send to owner' : t('approve').replace(' ✓', '')}</button>
      </div>
    </div>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(value - 1)} aria-label="less">−</button>
      <input inputMode="numeric" value={value || ''} placeholder="0" onChange={e => onChange(Number(e.target.value.replace(/\D/g, '')) || 0)} aria-label="quantity" />
      <button onClick={() => onChange(value + 1)} aria-label="more">+</button>
    </div>
  );
}
