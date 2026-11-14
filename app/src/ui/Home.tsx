import { fillPendingValues } from '../core/credit';
import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, ClipboardCheck, Route, MapPinned, IndianRupee, Banknote, Boxes, FileCheck2, Scale, BarChart3, PackageOpen, Truck, Store, ListChecks, Upload, Users, Receipt, ShoppingBag, PackagePlus, Landmark, Wallet, PieChart, Printer, ClipboardList, Target, UserPlus, CalendarCheck, Clock, TrendingUp, Download, FileWarning, Hourglass, ReceiptText } from 'lucide-react';
import { counts } from '../core/pipeline';
import { db, today, session } from '../core/db';
import type { ModuleKey, Role } from '../core/types';
import { licenceState } from '../core/licence';
import { ENV_SERVER } from '../core/sync';
import { MODULE_ICON } from './icons';
import { Send } from 'lucide-react';
import { ownerNumbers } from '../core/ownerCard';
import { inr, plural } from '../core/i18n';
import { waitingRequests } from '../core/requests';

export type Page = 'home'
  | 'orders-received' | 'verify' | 'billed' | 'newshops' | 'targets' | 'beat' | 'myday' | 'newshop' | 'orders-excel'
  | 'stockin' | 'stock' | 'damages' | 'ageing' | 'stock-reports'
  | 'plan' | 'live' | 'status' | 'trips' | 'load' | 'print' | 'trip' | 'pick'
  | 'collect' | 'outstanding' | 'cash' | 'cheques'
  | 'bank' | 'expenses' | 'pnl' | 'cashflow' | 'export' | 'reports' | 'vans'
  | 'gst' | 'today' | 'salary' | 'staff' | 'claims' | 'dayclose' | 'bills'
  | 'lite-shops' | 'lite-plan' | 'lite-delivery' | 'lite-collect' | 'lite-export' | 'more' | 'billing'
  | 'inbound' | 'reorder' | 'settings' | 'links' | 'tesrax' | 'boost' | 'privacy'; // linked companies: their bills to receive, and the order to them

interface Tile { page?: Page; module?: string; icon: LucideIcon; en: string; count?: number; tone?: 'bad' | 'warn' | 'ok'; tag?: string; mod?: ModuleKey }

export function standalone(mods: Record<ModuleKey, boolean> | undefined) { return !!mods && !mods.bill && !mods.sales; }
// which paid module each home tile belongs to: a tile shows only if that module is in the licence
const NEED: Partial<Record<Page, ModuleKey>> = {
  beat: 'sales', newshop: 'sales', myday: 'sales', collect: 'collection', pick: 'bill', load: 'delivery', print: 'delivery',
  stockin: 'inventory', stock: 'inventory', damages: 'inventory', trip: 'delivery', gst: 'gst', dayclose: 'bill',
  'lite-delivery': 'delivery', 'lite-plan': 'delivery', 'lite-collect': 'collection',
};

// a module's line says what is waiting in it ("1 order to approve · 1 to verify"), never a slogan
const WAITING: Partial<Record<Page, (n: number) => string>> = {
  'orders-received': n => `${plural(n, 'order')} to approve`, verify: n => `${n} to verify`, newshops: n => `${plural(n, 'new shop')} to approve`,
  inbound: n => `${plural(n, 'company bill')} to receive`, stock: n => `${plural(n, 'stock alert')}`, claims: n => `${plural(n, 'claim')} open`,
  plan: n => `${plural(n, 'bill')} to plan`, live: n => `${plural(n, 'van')} out`, status: n => `${plural(n, 'bill')} with differences`,
  cash: n => `${plural(n, 'person', 'people')} holding cash`, today: n => `${plural(n, 'request')} to approve`,
};
const waitingLine = (ts: Tile[]) => ts.filter(x => x.count && x.page && WAITING[x.page]).map(x => WAITING[x.page!]!(x.count!)).join(' · ') || 'Nothing waiting here.';

// Opening screen: module icons with counts. Tap a module → its few screens. Nothing else.
export function Home({ role, go, open, onOpen }: { role: Role; go: (p: Page) => void; open: string | null; onOpen: (m: string | null) => void }) {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [subs, setSubs] = useState<Record<string, Tile[]>>({});
  const [morning, setMorning] = useState<{ name: string; orders: number; toDeliver: number; sales: number; outstanding: number; canReports: boolean; canOutstanding: boolean; leaves: number; advances: number; staffReqs: number; first: Page | null } | null>(null);
  useEffect(() => {
    (async () => {
      const s = await db.settings.toCollection().first();
      // values saved on staff phones without the buying rate are filled in here (owner's phone only)
      if (role === 'owner') void fillPendingValues({ throttle: true }).catch(() => 0);
      const mods = (await licenceState(!!ENV_SERVER, s)).mods;
      const c = await counts();
      const me = session().userId;
      const newShops = (await db.shops.toArray()).filter(x => !x.approved).length;
      const leaves = (await db.leaves.where('status').equals('waiting').count()) + (await db.advances.where('status').equals('waiting').count());
      const checkedIn = (await db.checkIns.where('date').equals(today()).count());
      const staffN = (await db.staff.toArray()).filter(x => x.active && x.role !== 'owner').length;
      const diffs = (await db.invoices.toArray()).filter(i => !i.cancelled && i.delivery && !i.diffAction && ((i.delivery.shortages?.length ?? 0) > 0 || (i.delivery.excess?.length ?? 0) > 0)).length;
      const sub: Record<string, Tile[]> = {};
      let t: Tile[] = [];
      if (standalone(mods)) {
        const plan = await db.dayPlans.where('date').equals(today()).first();
        const done = (await db.liteEntries.where('date').equals(today()).toArray()).filter(e => e.kind !== 'payment').length;
        const shops = await db.shops.count();
        t = role === 'owner' || role === 'office' ? [
          { page: 'lite-shops', icon: Upload, en: 'Shop list', count: shops || undefined },
          { page: 'lite-plan', icon: ListChecks, en: "Today's shops", count: plan?.shopIds.length, tone: 'ok' },
          { page: 'lite-delivery', icon: Truck, en: 'Delivery', count: plan ? plan.shopIds.length - done : undefined, tone: 'bad' },
          { page: 'lite-collect', icon: IndianRupee, en: 'Collection' },
          { page: 'lite-export', icon: BarChart3, en: "Day's Excel" },
          { page: 'staff', icon: Users, en: 'Staff' },
        ] : [
          { page: 'lite-delivery', icon: Truck, en: 'Delivery', count: plan ? plan.shopIds.length - done : undefined, tone: 'bad' },
          { page: 'lite-collect', icon: IndianRupee, en: 'Collection' },
        ];
      } else if (role === 'owner' || role === 'office') {
        const owner = role === 'owner';
        sub.sales = [
          { page: 'newshops', icon: UserPlus, en: 'New shops', count: newShops, tone: 'warn' },
          { page: 'targets', icon: Target, en: 'Targets' },
          { page: 'beat', icon: Route, en: 'Beats' },
          { page: 'reports', icon: BarChart3, en: 'Sales reports', mod: 'sales' }, // item 16: the sales reports from the Sales tile
        ];
        sub.bill = [
          { page: 'orders-received', icon: ClipboardList, en: 'Orders received', count: c.toApproveOrders, tone: 'bad' },
          { page: 'verify', icon: ClipboardCheck, en: 'Verify picked', count: c.toApprove, tone: 'warn' },
          { page: 'billed', icon: Receipt, en: 'Billed' },
        ];
        const gotIds = new Set((await db.receipts.toArray()).map(r => r.inboundId));
        const inbound = (await db.inbound.toArray()).filter(i => !i.cancelled && !gotIds.has(i.id)).length;
        const linked = (await db.companies.toArray()).some(c => c.link?.status === 'linked');
        sub.inventory = [
          ...(linked || inbound ? [{ page: 'inbound' as Page, icon: Truck, en: 'Company bills', count: inbound || undefined, tone: 'bad' as const }, { page: 'reorder' as Page, icon: Send, en: 'Order to company' }] : []),
          { page: 'stockin', icon: PackagePlus, en: 'Purchases' },
          { page: 'stock', icon: Boxes, en: 'Stock position', count: c.stockAlerts, tone: 'warn' },
          { page: 'damages', icon: FileWarning, en: 'Damages' },
          { page: 'ageing', icon: Hourglass, en: 'Ageing' },
          { page: 'claims', icon: FileCheck2, en: 'Claims', count: c.claimsOpen },
          { page: 'stock-reports', icon: TrendingUp, en: 'Reports' },
        ];
        sub.delivery = [
          { page: 'plan', icon: Route, en: 'Plan', count: c.toPlan, tone: 'warn' },
          ...(owner ? [{ page: 'live' as Page, icon: MapPinned, en: 'Live', count: c.out, tone: 'ok' as const }] : []),
          { page: 'status', icon: Truck, en: 'Delivery status', count: diffs || undefined, tone: 'bad' },
          { page: 'trips', icon: BarChart3, en: 'Trip reports' },
          ...(owner ? [{ page: 'vans' as Page, icon: Truck, en: 'Vans & drivers' }] : []),
        ];
        // Accountant = the owner's accounts employee (founder, 14 Nov 2026): collection, GST and day close live here too
        sub.accountant = [
          { page: 'outstanding', icon: Wallet, en: 'Outstanding', mod: 'collection' },
          ...(owner ? [{ page: 'cash' as Page, icon: Banknote, en: 'Cash with staff', count: c.cashStaff, tone: 'bad' as const, mod: 'collection' as ModuleKey }] : []),
          { page: 'cheques', icon: ReceiptText, en: 'Cheques & UPI', mod: 'collection' },
          { page: 'bank', icon: Landmark, en: 'Bank', mod: 'accountant' },
          { page: 'expenses', icon: Wallet, en: 'Expenses', mod: 'accountant' },
          ...(owner ? [{ page: 'pnl' as Page, icon: PieChart, en: 'P&L', mod: 'accountant' as ModuleKey }] : []), // profit is the owner's only
          { page: 'cashflow', icon: Scale, en: 'Cash flow', mod: 'accountant' },
          { page: 'gst', icon: FileCheck2, en: 'GST', mod: 'gst' },
          { page: 'reports', icon: BarChart3, en: 'Reports', mod: 'accountant' },
          { page: 'export', icon: Download, en: 'Export', mod: 'accountant' },
          ...(owner ? [{ page: 'dayclose' as Page, icon: Scale, en: 'Day close', count: c.dayClosed ? undefined : (c.tripsToday || diffs || undefined), tone: 'ok' as const, mod: 'bill' as ModuleKey }] : []),
        ];
        sub.payroll = [
          { page: 'today', icon: CalendarCheck, en: 'Today', count: leaves || undefined, tone: 'warn' },
          { page: 'staff', icon: Users, en: 'Staff' },
          ...(owner ? [{ page: 'salary' as Page, icon: IndianRupee, en: 'Salary sheet' }] : []),
        ];
        for (const k of Object.keys(sub)) sub[k] = sub[k].filter(x => !x.mod || mods[x.mod] !== false); // each screen only with its own module
        const sum = (k: string) => sub[k].reduce((a, x) => a + (x.count ?? 0), 0) || undefined;
        const tone = (k: string) => sub[k].find(x => x.count && x.tone === 'bad') ? 'bad' : sub[k].find(x => x.count && x.tone === 'warn') ? 'warn' : 'ok';
        // Home = six modules, Sales first (founder, 14 Nov 2026)
        t = [
          { module: 'sales', icon: ShoppingBag, en: 'Sales', count: sum('sales'), tone: tone('sales') },
          { module: 'bill', icon: Receipt, en: 'Bill', count: sum('bill'), tone: tone('bill') },
          { module: 'delivery', icon: Truck, en: 'Delivery', count: sum('delivery'), tone: tone('delivery') },
          { module: 'accountant', icon: Landmark, en: 'Accountant', count: sum('accountant'), tone: tone('accountant') },
          { module: 'inventory', icon: Boxes, en: 'Stock', count: sum('inventory'), tone: tone('inventory') },
          { module: 'payroll', icon: Users, en: 'Payroll', count: sum('payroll') || (staffN - checkedIn > 0 ? staffN - checkedIn : undefined), tone: sum('payroll') ? 'warn' : 'bad' },
        ];
      } else if (role === 'salesman') {
        const myShops = (await db.shops.toArray()).filter(x => x.salesmanId === me);
        const visited = new Set((await db.visits.where('date').equals(today()).toArray()).filter(v => v.staffId === me).map(v => v.shopId));
        t = [
          { page: 'beat', icon: Route, en: "Today's beat", count: (() => { const d = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()]; const todays = myShops.filter(x => x.beat === d || x.aliases.includes(`beat:${d}`)); return todays.filter(x => !visited.has(x.id)).length || undefined; })(), tone: 'ok' },
          { page: 'collect', icon: IndianRupee, en: 'Collect' },
          { page: 'myday', icon: BarChart3, en: 'My day' },
          { page: 'newshop', icon: UserPlus, en: 'New shop' },
        ];
      } else if (role === 'godown') {
        const gotIds = new Set((await db.receipts.toArray()).map(r => r.inboundId));
        const inbound = (await db.inbound.toArray()).filter(i => !i.cancelled && !gotIds.has(i.id)).length;
        t = [
          { page: 'pick', icon: PackageOpen, en: 'Pick orders', count: c.toPick, tone: 'bad' },
          { page: 'verify', icon: ClipboardCheck, en: 'Verify picked', count: c.toApprove || undefined }, // Ordered/Picked only (no rates)
          ...(inbound ? [{ page: 'inbound' as Page, icon: Truck, en: 'Company bills', count: inbound, tone: 'bad' as const }] : []),
          { page: 'load', icon: Truck, en: 'Load vans', count: c.toLoad, tone: 'warn' },
          { page: 'print', icon: Printer, en: 'Print load sheet' },
          { page: 'stockin', icon: PackagePlus, en: 'Stock in' },
          { page: 'stock', icon: Boxes, en: 'Stock', count: c.stockAlerts },
          { page: 'damages', icon: FileWarning, en: 'Damages' },
        ];
      } else {
        t = [
          { page: 'trip', icon: Truck, en: 'My trip', count: c.stopsLeft, tone: 'bad' },
          { page: 'collect', icon: IndianRupee, en: 'Collect' },
        ];
      }
      const on = (k: ModuleKey) => mods[k] !== false;
      const allowed = (x: Tile) => x.module === 'accountant' ? sub.accountant?.length > 0 : x.module ? on(x.module as ModuleKey) : !(x.page && NEED[x.page]) || mods[NEED[x.page]!];
      setTiles(t.filter(allowed)); setSubs(sub);
      if ((role === 'owner' || role === 'office') && !standalone(mods)) {
        // the owner's two numbers (founder, 14 Nov 2026), by the same rules as Reports and the Outstanding screen
        const { sales, outstanding } = await ownerNumbers();
        const leaveN = await db.leaves.where('status').equals('waiting').count();
        const advanceN = await db.advances.where('status').equals('waiting').count();
        const reqN = (await waitingRequests()).length;
        const meName = (await db.staff.get(me))?.name.split(' ')[0] ?? '';
        setMorning({ name: meName, orders: c.toApproveOrders, toDeliver: c.toPlan, sales: Math.round(sales), outstanding: Math.round(outstanding), canReports: mods.accountant !== false, canOutstanding: mods.collection !== false, leaves: leaveN, advances: advanceN, staffReqs: reqN, first: c.toApproveOrders ? 'orders-received' : c.toApprove ? 'verify' : c.toPlan ? 'plan' : (leaveN || advanceN) ? 'today' : diffs ? 'status' : null });
      } else setMorning(null);
    })();
  }, [role, open]);

  const shut = open && !(subs[open]?.length) ? null : open; // a module with nothing in this plan → the six tiles, never a blank page
  const list = shut ? subs[shut] ?? [] : tiles;
  const label = (t: Tile) => t.en;
  const tag = shut ? waitingLine(subs[shut] ?? []) : null;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <div className={`home n${list.length}`}>
      {!shut && morning && (
        <div className="morning">
          <div className="grow">
            <div className="t">{greet}{morning.name ? `, ${morning.name}` : ''}.</div>
            <div className="s">{(() => { const w = [morning.orders ? `${plural(morning.orders, 'order')} waiting for your OK` : '', morning.toDeliver ? `${plural(morning.toDeliver, 'bill')} to plan for delivery` : '', morning.leaves ? `${plural(morning.leaves, 'leave request')}` : '', morning.advances ? `${plural(morning.advances, 'advance request')}` : '', morning.staffReqs ? `${plural(morning.staffReqs, 'staff request')} (returns, write-offs)` : ''].filter(Boolean); return w.length ? `${w.join(' · ')}.` : 'Nothing is waiting on you right now.'; })()}</div>
            <div className="hk"><button disabled={!morning.canReports} onClick={() => go('reports')}><b>{inr(morning.sales)}</b><span>{'Sales this month so far, before GST'}</span></button><button disabled={!morning.canOutstanding} onClick={() => go('outstanding')}><b>{inr(morning.outstanding)}</b><span>{'Outstanding'}</span></button></div>
            {morning.first && <button className="pill" onClick={() => go(morning.first!)}>{'Start here'} →</button>}
          </div>
        </div>
      )}
      {shut && <div className="home-back"><button onClick={() => onOpen(null)} aria-label="Back"><ArrowLeft /></button><span>{tiles.find(x => x.module === shut) ? label(tiles.find(x => x.module === shut)!) : shut}</span></div>}
      {tag && <div className="home-tag">{tag}</div>}
      {list.map(t => (
        <button key={t.page ?? t.module} className={`tile ${t.module ? 'module' : ''}`} onClick={() => t.module ? onOpen(t.module) : go(t.page!)}>
          <span className="tile-ic">{t.module && MODULE_ICON[t.module] ? MODULE_ICON[t.module]({ size: 34 }) : t.page === 'dayclose' ? MODULE_ICON.dayclose({ size: 34 }) : t.page === 'gst' ? MODULE_ICON.gst({ size: 34 }) : <t.icon size={30} />}</span>
          <span className="tile-l">{label(t)}</span>
          {t.count ? <span className={`tile-n ${t.tone ?? ''}`}>{t.count}</span> : null}
        </button>
      ))}
      {!list.length && <div className="muted">…</div>}
    </div>
  );
}

export const StoreIcon = Store;
export const ClockIcon = Clock;
