import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, AlertTriangle, Phone, Store, MessageSquare, Download, BarChart3, Plus, Undo2, History } from 'lucide-react';
import { ChangeSet, db, getSettings } from '../core/db';
import { isInterState } from '../core/gst';
import { sameProductTwiceOn } from '../core/billing';
import { approveOrder, flagArrivedOrders, rejectOrder } from '../core/pipeline';
import { allOutstanding } from '../core/ledger';
import { editOrder, orderActivity, orderView, ordersSheet, undoApprove } from '../core/orderEdit';
import { downloadWorkbook } from '../core/readers';
import { lineOf } from '../core/lines';
import { norm } from '../core/match';
import { inr, plural, showTime } from '../core/i18n';
import { ask, askText, notify } from './dialog';
import { useBack } from './useBack';
import { OPEN_ORDER_KEY } from '../core/tesraxOrders';
import type { Order, OrderLine, Product, Scheme, Settings, Shop } from '../core/types';

type Hist = { bills: number; amount: number; oldestDays: number; late: number; limit: number; days: number }; // late: days past the credit days
type Row = Order & { shop: Shop; hist: Hist; salesman: string };

// Bill → Orders received (Part 2 item 8, docs/PART2_UX.md 2b): one card per order → tap opens the order as stacked line cards
// (Qty, Rate, Disc %), the shop's history on top, Approve at the bottom (one tap, Undo until the godown packs it).
export function OrdersReceived({ go }: { go?: (p: string) => void } = {}) {
  const [list, setOrders] = useState<Row[] | null>(null);
  const orders = list ?? [];
  const [products, setProducts] = useState<Map<string, Product>>(new Map());
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [cfg, setCfg] = useState<Settings | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; shop: string } | null>(null);
  useEffect(() => {
    (async () => {
      await flagArrivedOrders(); // a rep's order that just came in gets its stock / credit flags first
      const shops = new Map((await db.shops.toArray()).map(s => [s.id, s]));
      const staff = new Map((await db.staff.toArray()).map(s => [s.id, s.name]));
      const cos = new Map((await db.companies.toArray()).map(c => [c.id, c.name]));
      const who = (o: Order) => o.source === 'company' ? `${cos.get(o.companyId ?? '') ?? 'Company'} rep ${o.companyRep ?? ''}`.trim() : staff.get(o.salesmanId ?? '') ?? o.source;
      setProducts(new Map((await db.products.toArray()).map(p => [p.id, p])));
      setSchemes(await db.schemes.toArray()); setCfg(await getSettings());
      const os = (await db.orders.toArray()).filter(o => o.status === 'new' || o.status === 'needs_ok').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const dues = await allOutstanding();
      const hist = (s: Shop): Hist => { const d = dues.get(s.id); return { bills: d?.bills ?? 0, amount: d?.amount ?? 0, oldestDays: d?.oldestDays ?? 0, late: d?.maxOverdueDays ?? 0, limit: s.creditLimit, days: s.creditDays }; };
      setOrders(os.filter(o => shops.has(o.shopId)).map(o => { const shop = shops.get(o.shopId)!; return { ...o, shop, hist: hist(shop), salesman: who(o) }; }));
      try { const want = sessionStorage.getItem(OPEN_ORDER_KEY); if (want) { sessionStorage.removeItem(OPEN_ORDER_KEY); if (os.some(o => o.id === want)) setOpen(want); } } catch { /* no storage */ } // TESRAX "open order <shop>"
    })();
  }, [tick]);
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 8000); return () => clearTimeout(t); }, [undo]);

  const inter = (o: Row) => isInterState(o.shop, cfg ?? { stateCode: '' });
  const value = (o: Row) => orderView(o.lines, products, schemes, inter(o)).total;
  const bad = (o: Row) => (o.hist.limit > 0 && o.hist.amount + value(o) > o.hist.limit) || (o.hist.days > 0 && o.hist.oldestDays > o.hist.days);
  const clean = orders.filter(o => !o.issues.length && !bad(o) && !o.rateRemark && o.source !== 'office');
  const approve = async (o: Row) => {
    try { await approveOrder(o.id); setOrders(l => (l ?? []).filter(x => x.id !== o.id)); setOpen(null); setUndo({ id: o.id, shop: o.shop.name }); }
    catch (e) { void notify('Not approved', (e as Error).message); setTick(x => x + 1); }
  };
  const excel = async () => { const s = await ordersSheet(orders.map(o => o.id)); await downloadWorkbook(`Orders-received-${new Date().toISOString().slice(0, 10)}`, [s]); };
  const current = orders.find(o => o.id === open);
  useBack(() => { if (!open) return false; setOpen(null); setTick(x => x + 1); return true; }); // the app's back goes up to the list

  if (current) return <OrderEditor o={current} products={products} schemes={schemes} inter={inter(current)} bad={bad(current)} twice={sameProductTwiceOn(cfg)}
    onBack={() => { setOpen(null); setTick(x => x + 1); }} onApprove={() => approve(current)} onChanged={() => setTick(x => x + 1)} />;
  return (
    <div className="stack">
      <div className="sechead"><h3>{'Orders received'} · {orders.length}</h3></div>
      {(orders.length > 0 || go) && <div className="row" style={{ gap: 6 }}>
        {orders.length > 0 && <button className="btn small" onClick={() => void excel()}><Download size={14} /> Excel</button>}
        {go && <button className="btn small" onClick={() => go('reports')}><BarChart3 size={14} /> {'Bill reports'}</button>}
      </div>}
      {undo && <div className="alert ok"><Check /><div className="grow">{'Approved. Sent to godown'} · {undo.shop}</div><button className="btn small" onClick={async () => { try { await undoApprove(undo.id); setUndo(null); setTick(x => x + 1); } catch (e) { void notify('Can\'t undo', (e as Error).message); setUndo(null); } }}><Undo2 size={14} /> {'Undo'}</button></div>}
      {clean.length > 1 && <button className="link" onClick={async () => { for (const o of clean) await approveOrder(o.id).catch(() => {}); setTick(x => x + 1); }}>{`Approve all ${clean.length} clean`}</button>}
      {orders.map(o => (
        <button key={o.id} className="card stack tap" style={{ gap: 4, textAlign: 'left', width: '100%' }} onClick={() => setOpen(o.id)}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <div className="grow" style={{ minWidth: 0 }}><div className="t" style={{ fontWeight: 700, fontSize: 'var(--f4)' }}>{o.shop.name}</div><div className="muted">{o.shop.area} · {o.salesman} · {plural(o.lines.length, 'line')}</div></div>
            <div style={{ textAlign: 'right' }}><div className="amt num">{inr(value(o))}</div><span className={`badge ${o.status === 'needs_ok' || o.issues.length || bad(o) ? 'warn' : 'ok'}`}>{o.status === 'needs_ok' || o.issues.length || bad(o) ? 'Needs OK' : 'New'}</span></div>
          </div>
        </button>
      ))}
      {!list && <div className="card muted">{'Loading orders…'}</div>}
      {list && !orders.length && <div className="card" style={{ textAlign: 'center' }}><div className="avatar ok" style={{ margin: '0 auto 8px' }}><Check /></div>{'No orders waiting.'}</div>}
    </div>
  );
}

function OrderEditor({ o, products, schemes, inter, bad, twice, onBack, onApprove, onChanged }: { o: Row; products: Map<string, Product>; schemes: Scheme[]; inter: boolean; bad: boolean; twice: boolean; onBack: () => void; onApprove: () => Promise<void>; onChanged: () => void }) {
  const [lines, setLines] = useState<OrderLine[]>(o.lines);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<Product[]>([]);
  const [log, setLog] = useState<{ at: string; by: string; what: string }[]>([]);
  useEffect(() => { void orderActivity(o.id).then(setLog); }, [o.id, o.updatedAt]);
  useEffect(() => { (async () => {
    // the last 5 products this shop ordered, for a one-tap add
    const past = (await db.orders.where('shopId').equals(o.shopId).toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const ids: string[] = []; for (const x of past) for (const l of x.lines) if (!ids.includes(l.productId)) ids.push(l.productId);
    setRecent(ids.map(id => products.get(id)).filter((p): p is Product => !!p && p.active).slice(0, 5));
  })(); }, [o.shopId, products]);
  const view = useMemo(() => orderView(lines, products, schemes, inter), [lines, products, schemes, inter]);
  const dirty = JSON.stringify(lines) !== JSON.stringify(o.lines);
  const orig = new Map((o.original ?? []).map((l, i) => [lineOf(l, i), l.qty]));
  const set = (i: number, patch: Partial<OrderLine>) => setLines(ls => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const remove = async (i: number) => {
    if (lines.length === 1) {
      const r = await ask('An order needs at least one item. Cancel the order instead', { choices: [{ label: 'Keep order', value: '' }, { label: 'Cancel order', value: 'cancel', tone: 'primary' }] });
      if (r === 'cancel') await cancel();
      return;
    }
    setLines(ls => ls.filter((_, k) => k !== i));
  };
  const adding = useRef(false);
  const add = async (p: Product) => {
    if (adding.current) return; adding.current = true; // a double tap adds one line, not two
    try {
      const at = lines.findIndex(l => l.productId === p.id);
      // the same product again (item 34): "Add to line N" (default) or "Keep as new line" — not on a company's order
      const choice = at < 0 ? 'new' : (!twice || o.source === 'company') ? 'add'
        : await ask(`Already in bill (line ${at + 1})`, { choices: [{ label: 'Keep as new line', value: 'new' }, { label: `Add to line ${at + 1}`, value: 'add', tone: 'primary' }] });
      if (!choice) return;
      if (choice === 'add') set(at, { qty: lines[at].qty + 1 }); else setLines(ls => [...ls, { productId: p.id, qty: 1, rate: p.rate }]);
      setQ('');
    } finally { adding.current = false; }
  };
  const save = async () => { await editOrder(o.id, lines); onChanged(); };
  const run = async (f: () => Promise<void>) => {
    if (busy) return; setBusy(true);
    try { await f(); } catch (e) { void notify('Not saved', (e as Error).message); } finally { setBusy(false); }
  };
  const cancel = async () => { const r = await askText('Why cancel?'); if (!r) return; await rejectOrder(o.id, r); onBack(); };
  const found = q ? [...products.values()].filter(p => p.active && norm(p.name).includes(norm(q))).slice(0, 6) : [];
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <div className="grow" style={{ minWidth: 0 }}><div className="h">{o.shop.name}</div><div className="muted">{o.shop.area} · {o.salesman}</div></div>
        <a className="icon-btn" href={`tel:${o.shop.phone ?? ''}`} aria-label="Call shop"><Phone size={18} /></a>
        <button className="icon-btn" onClick={() => void run(cancel)} aria-label="Cancel order"><X size={18} /></button>
      </div>
      <div className={`hist ${bad ? 'bad' : ''}`}>
        <Store size={14} /> {o.hist.bills
          ? <><b>{inr(o.hist.amount)}</b> {'unpaid'} · {o.hist.late > 0 ? <b>{plural(o.hist.late, 'day')} {'past credit'}</b> : 'within credit'}</>
          : <>{'No unpaid bills'}{o.hist.days > 0 && <> · {plural(o.hist.days, 'day')} {'credit'}</>}</>}
        {o.hist.limit > 0 && o.hist.amount + view.total > o.hist.limit && <> · {'over limit'} {inr(o.hist.limit)}</>}
      </div>
      {o.rateRemark && <div className="alert"><MessageSquare /><div><b>{'Rate request'}:</b> {o.rateRemark}</div></div>}
      {o.source !== 'salesman' && o.source !== 'company' && <div className="row" style={{ alignItems: 'center', gap: 6 }}><span className="muted">{'How did this order come?'}</span><select value={o.source === 'office' ? '' : o.source} onChange={async e => { const cs = new ChangeSet(); cs.put('orders', { ...o, source: (e.target.value || 'office') as Order['source'] }, 'order source'); await cs.commit('Order source'); onChanged(); }}><option value="">{'pick'}</option><option value="phone">{'Phone'}</option><option value="in_person">{'In person'}</option><option value="whatsapp">WhatsApp</option><option value="other">{'Other'}</option></select></div>}
      {o.issues.filter(x => !/^Overdue \d+ days/.test(x)).length > 0 && <div className="alert"><AlertTriangle /><div>{o.issues.filter(x => !/^Overdue \d+ days/.test(x)).map((x, i) => <div key={i}>{x}</div>)}</div></div>}
      {lines.map((l, i) => {
        const r = view.rows[i]; const p = products.get(l.productId);
        const was = orig.get(lineOf(l, i));
        return (
          <div key={`${lineOf(l, i)}-${i}`} className="linecard">
            <div className="lc-head"><div className="lc-name">{i + 1}. {p?.name ?? 'Unknown item'}</div>
              <button className="icon-btn" onClick={() => void remove(i)} aria-label={`Remove ${p?.name ?? 'line'}`}><X size={18} /></button></div>
            <div className="lc-boxes">
              <div className="lc-box"><label>{'Qty'}</label><NumBox whole value={l.qty} onChange={v => set(i, { qty: v })} label="Qty" /></div>
              <div className="lc-box"><label>{'Rate'}</label><NumBox value={l.rate} onChange={v => set(i, { rate: v })} label="Rate" /></div>
              <div className="lc-box"><label>{'Disc %'}</label><NumBox value={l.discountPct ?? r?.discountPct ?? 0} onChange={v => set(i, { discountPct: v })} label="Disc %" />{r && r.discount > 0 && <div className="lc-note">= {inr(r.discount)}</div>}</div>
            </div>
            <div className="lc-foot"><span>{r?.unit ?? 'PCS'} · GST {p?.gst ?? 0}%{was != null && was !== l.qty ? ` · Ordered ${was}` : ''}</span><span className="lc-amt num">{inr(r?.amount ?? 0)}</span></div>
          </div>
        );
      })}
      <div className="field"><input placeholder={'Add product'} value={q} onChange={e => setQ(e.target.value)} aria-label="Add product" />
        {found.length > 0 && <div className="list">{found.map(p => <button key={p.id} className="item tap" onClick={() => void add(p)}><Plus size={16} /><span className="grow">{p.name}</span><span className="muted">{inr(p.rate)}</span></button>)}</div>}
        {!q && recent.length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{recent.map(p => <button key={p.id} className="chip" onClick={() => void add(p)}>+ {p.name}</button>)}</div>}
      </div>
      {log.length > 0 && <details className="card"><summary className="muted"><History size={14} style={{ verticalAlign: -2 }} /> {'Activity'} · {log.length}</summary>
        <div className="list">{log.map((x, i) => <div key={i} className="row muted" style={{ fontSize: 'var(--f2)' }}>{showTime(x.at)} · {x.by}: {x.what}</div>)}</div></details>}
      <div className="bill-totals">
        <div><span>{'Taxable'}</span><b className="num">{inr(view.taxable)}</b></div>
        <div><span>{'Tax'}</span><b className="num">{inr(view.tax)}</b></div>
        <div><span>{'Round-off'}</span><b className="num">{view.roundOff.toFixed(2)}</b></div>
        <div className="grand"><span>{'Total'}</span><b className="num" style={{ color: 'var(--jade)' }}>{inr(view.total)}</b></div>
      </div>
      <div className="sticky-foot">
        {dirty && <button className="btn grow" disabled={busy} onClick={() => void run(save)}>{busy ? 'Saving…' : 'Save changes'}</button>}
        <button className="btn primary grow" disabled={busy || o.source === 'office'} onClick={() => void run(async () => { if (dirty) await editOrder(o.id, lines); await onApprove(); })}><Check /> {busy ? 'Saving…' : 'Approve'}</button>
      </div>
    </div>
  );
}

/** a number box that keeps what is typed ("3." while typing 3.5); tap selects the text */
export function NumBox({ value, onChange, label, whole }: { value: number; onChange: (v: number) => void; label: string; whole?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (Number(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <input inputMode={whole ? 'numeric' : 'decimal'} value={text} aria-label={label} onFocus={e => e.target.select()}
    onChange={e => { const t = whole ? e.target.value.replace(/\D/g, '') : e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'); setText(t); onChange(Number(t) || 0); }} />;
}
