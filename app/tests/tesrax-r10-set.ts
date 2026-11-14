// TESRAX round 10 sentence set (12 Nov 2026): every screen, report, export and common action, said the ways people really say them.
// Each sentence has the role who says it and what TESRAX should do:  'go:page' | 'export:x' | 'report:<key>:<period>' | an engine code;
//   '!go:page' = must NOT open it (this role may not);  'refused' = a clear no;  '~regex' = the code must match.
import type { Role } from '../src/core/types';
export interface Probe { s: string; role: Role; exp: string }
const O: Role = 'owner', F: Role = 'office', S: Role = 'salesman', G: Role = 'godown', D: Role = 'delivery';
const ALL: Role[] = [O, F, S, G, D];

/** the polite, long and plain ways of asking for a screen */
const WRAP = ['{n}', 'open {n}', 'show {n}', 'show me {n}', 'go to {n}', '{n} screen', 'can you please show me {n}', 'i want to see {n}', 'give me {n}', 'pls open {n}', 'take me to {n}', 'open the {n} page', 'let me see {n}', 'need {n}'];
/** small changes that real typing adds */
function noise(s: string, i: number): string {
  switch (i % 9) {
    case 1: return s[0].toUpperCase() + s.slice(1) + '.';
    case 3: return s.toUpperCase();
    case 5: return s + ' please';
    case 6: return s + ' sir';
    case 7: return s + '?';
    case 8: return 'pls ' + s;
    default: return s;
  }
}
let n = 0;
const out: Probe[] = [];
const add = (s: string, role: Role, exp: string) => { out.push({ s, role, exp }); };

// [page, roles that may open it, the names people use]
export const SCR: [string, Role[], string[]][] = [
  ['orders-received', [O, F], ['orders received', 'approve orders', 'pending orders', 'orders to approve', 'pending approvals']],
  ['verify', [O, F, G], ['picked to verify', 'to verify', 'verify orders', 'picked orders']],
  ['billed', [O, F], ['billed', 'bills', 'bill list', 'invoices', 'today bills']],
  ['newshops', [O, F], ['new shops', 'shops to approve', 'pending shops']],
  ['targets', [O, F], ['targets', 'sales targets']],
  ['myday', [S], ['my day', 'my targets', 'my orders']],
  ['stockin', [O, F, G], ['stock in', 'purchases', 'stock inward']],
  ['stock', [O, F, G], ['stock position', 'stock alerts', 'low stock', 'out of stock']],
  ['damages', [O, F, G], ['damages', 'damage register', 'damage list']],
  ['ageing', [O, F, G], ['ageing', 'aging', 'ageing report']],
  ['stock-reports', [O, F], ['stock report', 'stock reports']],
  ['claims', [O, F], ['claims', 'claim tracker', 'pending claims', 'claims list']],
  ['plan', [O, F], ['delivery plan', 'route plan', 'plan delivery']],
  ['live', [O], ['live vans', 'track van', 'where is the van']],
  ['status', [O, F], ['delivery status', 'delivered today', 'order status']],
  ['trips', [O, F], ['trip reports', 'trip report', 'trips']],
  ['vans', [O], ['vans and drivers', 'van list', 'vans']],
  ['load', [G], ['load vans', 'load van', 'loading']],
  ['print', [G, O, F], ['print load sheet']],
  ['pick', [G], ['pick orders', 'orders to pick', 'pack orders']],
  ['trip', [D], ['my trip', 'start trip']],
  ['collect', [O, F, S, D], ['collect', 'collection']],
  ['outstanding', [O, F], ['outstanding list', 'who owes', 'dues']],
  ['cash', [O], ['cash with staff', 'who has cash', 'staff cash']],
  ['cheques', [O, F], ['cheques and upi', 'cheques', 'upi list']],
  ['bank', [O, F], ['bank', 'bank statement']],
  ['expenses', [O, F], ['expenses', 'expense list']],
  ['pnl', [O], ['p&l', 'pnl', 'profit and loss', 'p and l']],
  ['cashflow', [O], ['cash flow', 'cashflow', 'net worth', 'payables', 'receivables']],
  ['reports', [O, F], ['reports', 'report list']],
  ['export', [O, F], ['export', 'exports', 'export screen']],
  ['gst', [O, F], ['gst', 'gst summary', 'gst report', 'gst status', 'gst due', 'tax summary']],
  ['dayclose', [O], ['day close', 'dayclose', 'close day', 'close the day', 'reconcile']],
  ['today', [O, F], ['attendance', 'who is absent', 'who is present', 'today attendance']],
  ['salary', [O], ['salary sheet', 'salary', 'salaries']],
  ['newshop', [S, O, F], ['add shop form', 'new shop form', 'onboard shop']],
  ['inbound', [O, F, G], ['company bills', 'supplier bills', 'bills from company', 'purchase bills']],
  ['reorder', [O, F], ['order to company', 'company order', 'reorder', 'purchase order']],
  ['staff', [O, F], ['staff list', 'staff and access', 'employees', 'my staff']],
  ['settings', [O, F], ['settings', 'firm details', 'app settings']],
  ['links', [O, F], ['company links', 'linked companies', 'link company']],
  ['tesrax', [O], ['tesrax report', 'tesrax score', 'tesrax misses']],
  ['billing', [O], ['plan and billing', 'my plan', 'subscription', 'licence', 'renewal']],
  ['module:inventory', [O, F], ['inventory', 'inventory module']],
  ['module:accountant', [O, F], ['accountant', 'accounts', 'accounting']],
  ['module:payroll', [O, F], ['payroll', 'payroll module']],
  ['module:sales', [O, F], ['sales module']],
  ['module:bill', [O, F], ['bill module', 'billing module']],
];
// beats: the salesman has Today's beat, the owner and office the Beat builder (same page id)
const BEATS: [Role[], string[]][] = [[[S], ['my shops', 'today beat', 'next shop', 'which shop next']], [[O, F], ['beats', 'beat builder', 'beat plan']]];

for (const [page, roles, names] of SCR) {
  const refused = ALL.filter(r => !roles.includes(r));
  names.forEach((nm, ni) => WRAP.forEach((w, wi) => {
    const s = noise(w.replace('{n}', nm), n++);
    add(s, roles[0], `go:${page}`);
    // the other roles who may open it: two ways of asking
    if (wi % 5 === 0) for (const r of roles.slice(1)) add(noise(w.replace('{n}', nm), n++), r, `go:${page}`);
    // a role that may not: never opens it (first name, three ways)
    if (ni === 0 && wi % 5 === 0 && !page.startsWith('module:') && page !== 'targets') for (const r of refused.slice(0, 2)) add(w.replace('{n}', nm), r, `!go:${page}`);
  }));
}
for (const [roles, names] of BEATS) for (const nm of names) WRAP.forEach(w => { add(noise(w.replace('{n}', nm), n++), roles[0], 'go:beat'); if (roles[1]) add(w.replace('{n}', nm), roles[1], 'go:beat'); });

// short forms, typos and voice-typing splits for screens
const SHORT: [string, string, Role?][] = [
  ['colln', 'collect'], ['collctn', 'collect'], ['stmt', 'bank'], ['bank stmt', 'bank'], ['stk position', 'stock'], ['stk alerts', 'stock'], ['stk in', 'stockin'], ['purch', 'stockin'],
  ['dmg list', 'damages'], ['dmgs', 'damages'], ['damge list', 'damages'], ['agng', 'ageing'], ['ageing rpt', 'ageing'], ['o/s list', 'outstanding'], ['outstdg list', 'outstanding'],
  ['exp list', 'expenses'], ['expns', 'expenses'], ['expences', 'expenses'], ['rpts', 'reports'], ['rpt', 'reports'], ['gst rpt', 'gst'], ['gst smry', 'gst'], ['g s t', 'gst'],
  ['sal sheet', 'salary'], ['salry sheet', 'salary'], ['attndnce', 'today'], ['attendence', 'today'], ['approvls', 'orders-received'], ['ordrs recd', 'orders-received'], ['pndg orders', 'orders-received'],
  ['approve', 'orders-received'], ['del plan', 'plan'], ['del status', 'status'], ['trip rpt', 'trips'], ['trip rpts', 'trips'], ['clm tracker', 'claims'], ['claim tracer', 'claims'],
  ['cheq list', 'cheques'], ['chqs', 'cheques'], ['upi lst', 'cheques'], ['cheques n upi', 'cheques'], ['reconcil', 'dayclose'], ['day clos', 'dayclose'], ['cashflw', 'cashflow'], ['cash flw', 'cashflow'],
  ['p n l', 'pnl'], ['p & l', 'pnl'], ['profit n loss', 'pnl'], ['proft and loss', 'pnl'], ['stock reprt', 'stock-reports'], ['stok report', 'stock-reports'], ['setings', 'settings'],
  ['sttings', 'settings'], ['staf list', 'staff'], ['empolyees', 'staff'], ['subscripton', 'billing'], ['comp bills', 'inbound'], ['co bills', 'inbound'], ['order to co', 'reorder'],
  ['new shps', 'newshops'], ['live van', 'live'], ['vans n drivers', 'vans'], ['van n driver', 'vans'], ['tesrax rpt', 'tesrax'], ['inventry', 'module:inventory'], ['accountnt', 'module:accountant'],
  ['pay roll', 'module:payroll'], ['day book', 'reports'], ['load shet print', 'print'],
];
SHORT.forEach(([s, p], i) => { add(s, p === 'collect' ? S : O, `go:${p}`); if (i % 2 === 0) add('pls ' + s, F, p === 'pnl' || p === 'cashflow' || p === 'cash' || p === 'live' || p === 'dayclose' || p === 'salary' || p === 'vans' || p === 'tesrax' || p === 'billing' ? `!go:${p}` : `go:${p}`); });

// reports: by name, for any period, in every polite way
const REP: [string, string[]][] = [
  ['daybook', ['day book', 'daybook', 'day-book', 'bill wise report', 'sales register', 'invoice register', 'bill register']],
  ['collections', ['collection report', 'collections report', 'collections by person', 'who collected', 'collection register']],
  ['fast', ['fast movers', 'fast moving items', 'fast mover', 'top selling items', 'best selling products', 'top products', 'fast selling']],
  ['slow', ['slow movers', 'slow moving items', 'slow selling', 'slow mover']],
  ['dead', ['dead stock', 'non moving stock', 'not moving items', 'no movement items']],
  ['himargin', ['high margin', 'high margin items', 'best margin', 'top margin products']],
  ['lomargin', ['low margin', 'low margin items', 'lowest margin', 'poor margin']],
  ['shop', ['shop wise', 'shop wise sales', 'shopwise', 'sales by shop', 'top shops', 'shop report']],
  ['company', ['company wise', 'company wise sales', 'brand wise', 'sales by company']],
  ['salesman', ['salesman wise', 'salesman report', 'staff wise sales', 'salesman performance', 'sales by salesman']],
  ['area', ['area wise', 'route wise', 'area wise sales', 'sales by area']],
  ['returns', ['returns report', 'return report', 'credit notes report', 'returns list']],
  ['scheme', ['scheme cost', 'scheme report', 'schemes cost', 'scheme spend']],
  ['sales', ['sales report', 'net sales report', 'sales excel', 'sales file']],
  ['all', ['all reports', 'every report', 'all reports excel', 'full report']],
];
const PER: [string, string][] = [['today', 'today'], ['yesterday', 'yesterday'], ['this week', 'this week'], ['last week', 'last week'], ['this month', 'this month'], ['last month', 'last month'], ['october', 'october'], ['last 90 days', '90 days']];
const RW = ['{n} {p}', 'send {n} {p}', 'can you please send me {n} {p}', 'i want {n} {p}', 'give me {n} {p}', 'show me {n} for {p}', 'need {n} {p}', 'download {n} {p}', 'excel of {n} {p}', 'send me {n} of {p}'];
REP.forEach(([key, names]) => names.forEach((nm, ni) => PER.forEach(([p, tok], pi) => {
  const w = RW[(ni * 3 + pi) % RW.length];
  add(noise(w.replace('{n}', nm).replace('{p}', p), n++), O, `report:${key}:${tok}`);
  if (pi % 4 === 0) add(w.replace('{n}', nm).replace('{p}', p), F, `report:${key}:${tok}`);
})));
// reports with the period left out (this month), short forms, voice splits, plurals; staff are refused
for (const [key, names] of REP) { for (const nm of names.slice(0, 3)) { add(nm, O, `report:${key}:this month`); add('send ' + nm, F, `report:${key}:this month`); add('send ' + nm + ' pls', S, 'refused'); } }
const REPSHORT: [string, string][] = [['fast movrs', 'fast'], ['fast movers rpt', 'fast'], ['slow movrs', 'slow'], ['dead stok', 'dead'], ['day bk', 'daybook'], ['dybook', 'daybook'], ['hi margin', 'himargin'], ['lo margin', 'lomargin'],
  ['shop wise rpt', 'shop'], ['salesman wise rpt', 'salesman'], ['company wise rpt', 'company'], ['area wise rpt', 'area'], ['scheme cost rpt', 'scheme'], ['sales rpt', 'sales'], ['returns rpt', 'returns'], ['collection rpt', 'collections'], ['all rpts', 'all']];
REPSHORT.forEach(([s, key]) => { add(s + ' last month', O, `report:${key}:last month`); add('send ' + s + ' this week', F, `report:${key}:this week`); });

// exports and files
const EXPORT: [string, string[]][] = [
  ['tally', ['tally export', 'export tally', 'send tally', 'tally xml', 'tally file', 'export to tally', 'send to tally', 'tally data', 'tally entries', 'tally xml file']],
  ['gstr1', ['gstr1', 'gstr 1', 'gstr-1', 'gst r1', 'gst r 1', 'g s t r 1', 'gst return', 'gstr one', 'gst return file', 'gstr1 excel', 'gstr1 file', 'gst r', 'gst r one', 'gstr 1 excel', 'send gstr', 'gst return excel']],
  ['einvoice', ['e-invoice', 'einvoice', 'e invoice', 'e invoice json', 'irn json', 'e invoice file', 'einvoice json', 'send e invoice', 'e-invoice file']],
  ['claims', ['claim file', 'claims file', 'claim export', 'claims export', 'claim report', 'claims report', 'make claim file', 'send claim file', 'claim excel']],
];
const EP = ['', ' october', ' last month', ' this month', ' for october'];
const EW = ['{n}{p}', 'send {n}{p}', 'can you please send me {n}{p}', 'i want {n}{p}', 'give me {n}{p}', 'export {n}{p}', 'need {n}{p}', 'make {n}{p}', 'download {n}{p}'];
EXPORT.forEach(([key, names]) => names.forEach((nm, ni) => EP.forEach((p, pi) => {
  const w = EW[(ni + pi * 2) % EW.length];
  const s = noise(w.replace('{n}', nm).replace('{p}', p), n++);
  add(s, O, `export:${key}`);
  if (pi % 2 === 0) add(w.replace('{n}', nm).replace('{p}', p), F, `export:${key}`);
  if (pi === 1) for (const r of [S, D]) add(w.replace('{n}', nm).replace('{p}', p), r, 'refused');
})));

// common actions, with the demo shops and products
const SHOPS = ['Murugan Stores', 'Selvam Kirana', 'Kumar Mart', 'Velan Provision', 'Annai Super Market'];
const sh = (full: string) => full.split(' ')[0].toLowerCase();
const ORD = ['{s} 5 case surf', '{s} 10 lifebuoy', 'send {s} 2 cases vim', '{s} order 3 case surf and 10 vim', 'pls send 5 cs surf to {s}', 'order for {s} 2 case atta', 'book order {s} 4 cs red label',
  '{s} wants 5 case surf', '{s} needs 10 pcs bingo', 'i want to order 5 case surf for {s}', '{s} 5 cse surf', '{s} five case surf', 'send 5 case surf {s}', '{s} 2 cases atta 3 cases surf', 'can you please book 5 case surf for {s}',
  '{s} 1 case lifebuoy and 2 case vim', 'need 4 case red label for {s}', '{s} order 10 pcs marie', '{s} 6 cs good day'];
for (const s of SHOPS) ORD.forEach((t, i) => { add(t.replace('{s}', i % 2 ? sh(s) : s), O, `order:${s}`); if (i % 3 === 0) add(t.replace('{s}', s), S, `order:${s}`); });
const PAY: [string, string][] = [['{s} paid 2450 cash', 'cash'], ['{s} pd 2450 cash', 'cash'], ['rcvd 2450 frm {s} cash', 'cash'], ['received 2450 from {s} by upi', 'upi'], ['{s} gave 2450 gpay', 'upi'],
  ['collected 2450 from {s} cash', 'cash'], ['{s} paid 3000 by upi', 'upi'], ['{s} paid 1500 phonepe', 'upi'], ['{s} paid two thousand cash', 'cash'], ['{s} 2k paid cash', 'cash'], ['{s} paid 5000 neft', 'bank'],
  ['{s} paid 800 cash today', 'cash'], ['received 1200 from {s} through gpay', 'upi'], ['{s} gave 700 cash', 'cash'], ['pymt 900 frm {s} cash', 'cash'], ['{s} payment 1000 cash', 'cash']];
const AMT: Record<string, string> = { '2450': '2450', '3000': '3000', '1500': '1500', 'two thousand': '2000', '2k': '2000', '5000': '5000', '800': '800', '1200': '1200', '700': '700', '900': '900', '1000': '1000' };
for (const s of SHOPS) PAY.forEach(([t, mode], i) => { const a = Object.keys(AMT).find(k => t.includes(k))!; add(t.replace('{s}', i % 2 ? sh(s) : s), O, `~^payment:${s}:${AMT[a]}:`); if (i % 4 === 0) add(t.replace('{s}', s), D, `~^payment:${s}:${AMT[a]}:`); void mode; });
const RET = ['{s} return 2 surf', '{s} returned 3 lifebuoy damaged', 'took back 2 case vim from {s}', '{s} rtn 2 surf', '{s} sent back 5 lifebuoy', 'return from {s} 2 case surf', 'can you please return 2 vim from {s}'];
for (const s of SHOPS) RET.forEach((t, i) => { add(t.replace('{s}', i % 2 ? sh(s) : s), O, `return:${s}`); if (i % 3 === 0) add(t.replace('{s}', s), S, `return:${s}`); });
const CAN: [string, string][] = [['cancel {s} order', `~^(orderCancel:{S}|orderEdit:(none|locked))$`], ['cancel order of {s}', `~^(orderCancel:{S}|orderEdit:(none|locked))$`], ['delete {s} order', `~^(orderCancel:{S}|orderEdit:(none|locked))$`],
  ['cancel {s} payment', '~^payCancel:'], ['cancel payment of {s}', '~^payCancel:'], ['delete {s} payment', '~^payCancel:'], ['cancel {s} bill', '~^billCancel:'], ['cancel bill of {s}', '~^billCancel:']];
for (const s of SHOPS) CAN.forEach(([t, e], i) => add(t.replace('{s}', i % 2 ? sh(s) : s), O, e.replace('{S}', s)));
for (const t of ['stock received', 'goods received', 'stock came', 'new stock came', 'stock inward', 'purchase entry', 'stock in entry', 'new stock', 'stock received today']) { add(t, O, 'go:stockin'); add(t, F, 'go:stockin'); add(t, G, 'go:stockin'); }
const EXPN: [string, string][] = [['van 1 diesel 1500', '1500'], ['diesel 1500', '1500'], ['paid 1500 for diesel', '1500'], ['spent 800 on tea', '800'], ['toll 120', '120'], ['puncture 250', '250'], ['petrol 500', '500'],
  ['rent 5000', '5000'], ['repair 2000 van', '2000'], ['lunch 150', '150'], ['coolie 600', '600'], ['loading charges 600', '600'], ['eb bill 3400', '3400'], ['electricity 3400', '3400'], ['snacks 90', '90'], ['tyre 4500', '4500'], ['fuel 700', '700'], ['tea 40', '40']];
for (const [t, a] of EXPN) { add(t, O, `~^expense:${a}:`); add('pls add expense ' + t, F, `~^expense:${a}:`); add('expense ' + t, O, `~^expense:${a}:`); }
for (const t of ['help', 'what can you do', 'what can i say', 'how to use', 'commands', 'menu', 'options']) for (const r of ALL) add(t, r, 'help');
for (const t of ['undo', 'undo last', 'undo that']) add(t, O, '~^undo');
for (const s of SHOPS) for (const t of ['{s} outstanding', '{s} balance', '{s} bal', '{s} due', 'how much does {s} owe', 'what is pending for {s}', 'who owes more than 10000', 'show outstanding of {s}']) add(t.replace('{s}', s), O, '~^t:');
export const PROBES: Probe[] = out;
/** [page, roles that may open it] — must agree with the app's screen table (checked in tesrax-r10.test.ts) */
export const SCREEN_ROLES = SCR.map(([page, roles]) => [page, roles] as const);

// ---- company side: head office (A), managers (M), reps (R) ----
export interface CoProbe { s: string; who: 'A' | 'M' | 'R'; exp: string }
export const CO_PHONE = { A: '9100000001', M: '9100000002', R: '9100000004' } as const;
const CW = ['{n}', 'open {n}', 'show me {n}', 'can you please show me {n}', 'i want to see {n}', 'give me {n}', 'go to {n}', 'take me to {n} screen'];
const CSCR: [string, ('A' | 'M' | 'R')[], string[]][] = [
  ['co-stock', ['A', 'M'], ['stock at distributors', 'days of stock', 'stock cover']],
  ['co-distributors', ['A', 'M'], ['distributors', 'distributor list', 'my distributors']],
  ['co-outlets', ['A', 'M'], ['shops', 'outlets', 'retailers', 'outlet list']],
  ['co-invoices', ['A'], ['invoices', 'sales register', 'upload invoices', 'invoices to distributors', 'primary invoices']],
  ['co-products', ['A'], ['products', 'price list', 'prices', 'products and prices']],
  ['co-schemes', ['A'], ['schemes', 'offers', 'scheme list']],
  ['co-team', ['A', 'M'], ['team', 'my team', 'reps', 'team list']],
  ['fd-team', ['A', 'M'], ['team today', 'who did not visit', 'not visited', 'where is the team']],
  ['fd-approvals', ['A', 'M'], ['approvals', 'leave requests', 'pending leave']],
  ['cl-inbox', ['A', 'M'], ['distributor claims', 'claims inbox', 'pending claims', 'claim inbox']],
  ['fd-targets', ['A', 'M'], ['targets', 'leaderboard']],
  ['fd-day', ['R'], ['start day', 'end day', 'my day', 'check in', 'attendance']],
  ['fd-beat', ['R'], ['beat', 'my shops', "today's beat", 'todays beat']],
  ['fd-orders', ['R'], ['my orders']],
  ['fd-month', ['R'], ['my sales', 'my target', 'my month']],
  ['fd-expenses', ['R'], ['travel and expenses', 'my expenses', 'travel claim', 'expense claim', 'ta da']],
  ['fd-newshop', ['R'], ['new shop', 'add shop']],
];
const co: CoProbe[] = []; let cn = 0;
for (const [page, who, names] of CSCR) names.forEach(nm => CW.forEach((w, wi) => {
  co.push({ s: noise(w.replace('{n}', nm), cn++), who: who[0], exp: `go:${page}` });
  if (wi % 3 === 0 && who[1]) co.push({ s: w.replace('{n}', nm), who: who[1], exp: `go:${page}` });
  if (wi === 1 && who.length === 1 && who[0] === 'A') co.push({ s: w.replace('{n}', nm), who: 'M', exp: 'refused' });
}));
for (const [s, who, exp] of [['sales this month', 'A', 't'], ['sales of Murugan distributors', 'M', 't'], ['low stock', 'A', 't'], ['low stock at distributors', 'M', 't'], ['help', 'A', 'help'], ['what can you do', 'R', 'help'],
  ['lunch 120', 'R', 'expense'], ['lunch 120, bus 45, lodge 800', 'R', 'expense'], ['tea 20 and auto 60', 'R', 'expense'], ['petrol 300', 'R', 'expense'], ['spent 150 on food', 'R', 'expense']] as const) co.push({ s, who, exp });
export const CO_PROBES: CoProbe[] = co;
