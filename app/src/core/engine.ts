import { inr, showDate, showDay, showMonth, plural } from './i18n';
// TESRAX: turns "send + say" into a Proposal (table to approve) or an answer.
// Understanding is rule-based first (free, offline, English). The AI is only used to
// read photos, never to decide money.
import { licenceState } from './licence';
import { db, getSettings, newId, session, today, ymd, daysFrom } from './db';
import { allOutstanding, invoiceBalances, OWED, r2 } from './ledger';
import { bestProduct, cleanSaid, closeProduct, findAmount, findShopInText, hasWord, learnNames, norm, parseItemLines, toPieces } from './match';
import {
  companyOptions, orderRow, productOptions, shopOptions, type Col, type Proposal, type Row,
} from './proposals';
export { orderRow, refreshOrderRow } from './proposals';
import { isImageOrPdf, isSheet, readBankRows, readBillHeader, readProductRows, readPurchaseRows, readSheet, readShopRows, toIsoDate } from './readers';
import { NoServerError, fileToDataUrl, looksBlurry, scanFile } from './scan';
import { MODULES, type ModuleKey, type Product, type Role, type Shop, type Staff } from './types';
import { exportClaims, exportEinvoice, exportGstr1, exportTally } from './exports';
import { costValue, creditValue, openPaid } from './credit';
import { STATES } from './gst';
import { categoryOf, modifyIntent } from './modify';
import { noOrderVisit } from './visitIntent';
const ENV_SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

export interface Reply {
  text: string;
  tone?: 'ok' | 'warn' | 'error';
  proposal?: Proposal;
  table?: { columns: string[]; rows: (string | number)[][]; name: string };
  actions?: { label: string; run: () => void | Promise<void> }[];
  go?: string; // open this screen (Page id in the app shell)
  link?: { label: string; page: string }; // an answer given in words, with a button to the screen behind it (never jumps away)
  parts?: Reply[];          // a message that asked for several things: one reply per thing, in the order said
  pending?: { said: string; need: 'shop' | 'amount' | 'date' }; // TESRAX asked which shop; the next message may just name it
  replaces?: boolean;       // a follow-up that changed the table just shown (the old one is closed)
  follow?: 'tap' | 'dropped'; // "yes" (tap ✓ to save) / "no" (table dropped)
  refused?: boolean;        // a clear no: not this role's screen or action
  missed?: boolean;         // TESRAX did not understand (counted in the TESRAX report)
}
export { handle } from './converse';
/** "8 cases", "8 cases + 4 pcs", "4 pcs" */
const cases = (q: number, size: number) => { const c = Math.floor(q / (size || 1)), r = q % (size || 1); return size > 1 ? [c ? plural(c, 'case') : '', r ? `${r} pcs` : ''].filter(Boolean).join(' + ') || '0' : `${q} pcs`; };
import { profitAndLoss, pnlTotals } from './pnl';
import { period, salesSummary } from './reports';
import { dayFigures } from './pipeline';
import { handleCompany } from './companyEngine';

// Screens TESRAX can open by name. Checked per role so a driver asking for "delivery plan" is told it is the owner's screen.
export const SCREENS: { page: string; name: string; roles: Role[]; words: string[] }[] = [
  { page: 'orders-received', name: 'Orders received', roles: ['owner', 'office'], words: ['orders received', 'approve', 'approve orders', 'pending orders', 'orders pending', 'new orders'] }, // "approve" (do it) opens the screen; "orders to approve", "needs ok", "approvals" are answered in place (W.needsOk)
  { page: 'verify', name: 'Verify picked', roles: ['owner', 'office'], words: ['verify picked', 'verify', 'to verify', 'picked', 'picked to verify', 'picked orders'] },
  { page: 'billed', name: 'Billed', roles: ['owner', 'office'], words: ['billed', 'billed bills', 'today bills'] },
  { page: 'newshops', name: 'New shops', roles: ['owner', 'office'], words: ['pending shops', 'new shop requests', 'shop requests', 'new shops', 'shops to approve'] },
  { page: 'targets', name: 'Targets', roles: ['owner', 'office'], words: ['sales targets', 'sales target', 'target list', 'target', 'targets'] },
  { page: 'myday', name: 'My day', roles: ['salesman'], words: ['sales target', 'sales targets', 'my target', 'my targets', 'target', 'targets'] },
  { page: 'stockin', name: 'Purchases', roles: ['owner', 'office', 'godown'], words: ['stock in', 'purchases', 'purchase'] },
  { page: 'ageing', name: 'Ageing', roles: ['owner', 'office', 'godown'], words: ['ageing report', 'aging report', 'ageing list', 'ageing', 'aging', 'old stock'] },
  { page: 'damages', name: 'Damages', roles: ['owner', 'office', 'godown'], words: ['damages', 'damage register', 'damages register', 'damaged register', 'damages list', 'damage list'] },
  { page: 'status', name: 'Delivery status', roles: ['owner', 'office'], words: ['delivery status', 'delivered today', 'order status', 'orders status'] },
  { page: 'trips', name: 'Trip reports', roles: ['owner', 'office'], words: ['trip report', 'trip reports', 'trips', 'km'] },
  { page: 'outstanding', name: 'Outstanding', roles: ['owner', 'office'], words: ['outstanding screen', 'outstanding page', 'outstanding list', 'who owes', 'dues'] },
  { page: 'cheques', name: 'Cheques & UPI', roles: ['owner', 'office'], words: ['cheques', 'cheque', 'pending cheques', 'upi list', 'cheques and upi', 'cheque and upi', 'upi payments', 'cheques upi'] },
  { page: 'bank', name: 'Bank', roles: ['owner', 'office'], words: ['bank', 'statement'] },
  { page: 'expenses', name: 'Expenses', roles: ['owner', 'office'], words: ['expenses', 'expense list'] },
  { page: 'pnl', name: 'P&L', roles: ['owner'], words: ['p&l', 'p l', 'pnl', 'p and l', 'profit', 'profit and loss', 'how much profit'] },
  { page: 'cashflow', name: 'Cash flow', roles: ['owner'], words: ['cash flow', 'cashflow', 'position', 'net worth', 'loans', 'who will pay', 'what do i owe', 'payables', 'receivables', 'pending cheques'] },
  { page: 'reports', name: 'Reports', roles: ['owner', 'office'], words: ['report list', 'reports list', 'report menu', 'reports', 'fast movers', 'slow movers', 'fast moving', 'slow moving', 'fast moving items', 'slow moving items', 'not moving', 'dead stock', 'high margin', 'low margin', 'shop wise', 'shop-wise', 'company wise', 'company-wise', 'salesman wise', 'salesman-wise', 'area wise', 'area-wise', 'returns report', 'scheme cost', 'day book', 'daybook', 'collections by person', 'collection by person', 'collections report', 'collection report'] },
  { page: 'vans', name: 'Vans & drivers', roles: ['owner'], words: ['van and driver', 'vans and driver', 'van and drivers', 'driver list', 'van list', 'vans', 'add van', 'my vans', 'vans and drivers', 'assign driver'] },
  { page: 'export', name: 'Export', roles: ['owner', 'office'], words: ['export', 'tally export'] },
  { page: 'gst', name: 'GST', roles: ['owner', 'office'], words: ['gst', 'gst summary', 'gst report', 'gst status', 'gst due', 'tax summary', 'gstr', 'gstr1', 'gstr-1', 'tax', 'e-invoice'] },
  { page: 'today', name: 'Today (attendance)', roles: ['owner', 'office'], words: ['attendance', 'who is in', 'who came', 'who is absent', 'absent', 'who is present', 'check in', 'checked in'] },
  { page: 'salary', name: 'Salary', roles: ['owner'], words: ['salary', 'salary sheet', 'salaries', 'pay sheet'] },
  { page: 'newshop', name: 'New shop', roles: ['salesman', 'owner', 'office'], words: ['add shop form', 'new shop form', 'onboard shop'] },
  { page: 'plan', name: 'Delivery plan', roles: ['owner', 'office'], words: ['delivery plan', 'plan delivery', 'plan the delivery', 'route plan', 'plan route', 'plan'] },
  { page: 'live', name: 'Live vans', roles: ['owner'], words: ['live van', 'live', 'live vans', 'where is the van', 'where is van', 'track van', 'track', 'tracking'] },
  { page: 'cash', name: 'Cash with staff', roles: ['owner'], words: ['cash with staff', 'staff cash', 'who has cash', 'who has the cash', 'who has money', 'cash with whom', 'cash with who', 'staff with cash'] },
  { page: 'stock', name: 'Stock position', roles: ['owner', 'office', 'godown'], words: ['stock position', 'stock alert', 'stock alerts', 'out of stock', 'stock list', 'stock screen', 'low stock', 'stock low', 'less stock', 'stock less', 'short stock'] },
  { page: 'claims', name: 'Claims', roles: ['owner', 'office'], words: ['claims', 'claim tracker', 'claims list', 'claim list', 'pending claims'] },
  { page: 'dayclose', name: 'Day close', roles: ['owner'], words: ['day close', 'dayclose', 'close day', 'close the day', 'reconcile', 'reconciliation'] },
  { page: 'stock-reports', name: 'Stock reports', roles: ['owner', 'office'], words: ['stock reports', 'stock report'] },
  { page: 'billed', name: 'Bills', roles: ['owner', 'office'], words: ['bills', 'invoices', 'bill list'] },
  { page: 'collect', name: 'Collect', roles: ['owner', 'office', 'salesman', 'delivery'], words: ['collect', 'collection'] },
  { page: 'pick', name: 'Pick orders', roles: ['godown'], words: ['pick', 'pick orders', 'orders to pick', 'pack'] },
  { page: 'print', name: 'Load sheet print', roles: ['godown', 'owner', 'office'], words: ['print load sheet', 'print', 'load sheet print'] },
  { page: 'load', name: 'Load vans', roles: ['godown'], words: ['load van', 'load vans', 'loading'] }, // "load sheet" is answered in place (with an Open Load vans button)
  { page: 'trip', name: 'My trip', roles: ['delivery'], words: ['trip', 'my trip', 'start trip', 'delivery'] },
  { page: 'beat', name: "Today's beat", roles: ['salesman'], words: ['beat', 'beats', 'today beat', 'my shops', 'next shop', 'next shops', 'which shop next', 'shops today'] },
  { page: 'myday', name: 'My day', roles: ['salesman'], words: ['my day', 'my orders'] },
  { page: 'inbound', name: 'Company bills', roles: ['owner', 'office', 'godown'], words: ['company bills', 'company bill', 'bills from company', 'supplier bills', 'purchase bills', 'bills to receive', 'company invoices'] },
  { page: 'reorder', name: 'Order to company', roles: ['owner', 'office'], words: ['order to company', 'company order', 'reorder', 're order', 'order company', 'purchase order', 'order from company'] },
  { page: 'staff', name: 'Staff', roles: ['owner', 'office'], words: ['staff', 'staff list', 'staff and access', 'staff access', 'employees', 'add staff', 'my staff', 'staff page'] },
  { page: 'settings', name: 'Settings', roles: ['owner', 'office'], words: ['settings', 'setting', 'firm details', 'app settings', 'my settings', 'business details'] },
  { page: 'links', name: 'Company links', roles: ['owner', 'office'], words: ['company links', 'company link', 'link company', 'linked companies', 'link a company'] },
  { page: 'tesrax', name: 'TESRAX report', roles: ['owner'], words: ['tesrax report', 'tesrax score', 'tesrax misses', 'tesrax mistakes'] },
  { page: 'billing', name: 'Plan & billing', roles: ['owner'], words: ['plan and billing', 'plan billing', 'my plan', 'subscription', 'licence', 'license', 'renew', 'renewal', 'app payment'] },
  { page: 'beat', name: 'Beats', roles: ['owner', 'office'], words: ['beats', 'beat builder', 'beat plan', 'beat list', 'make beat', 'beat setup'] },
  { page: 'boost', name: 'Business Boost', roles: ['owner', 'office'], words: ['business boost', 'boost', 'boost services', 'services', 'offers', 'offers and services', 'gst filing', 'ca help', 'working capital', 'business loan', 'stock insurance', 'godown insurance', 'insurance', 'printer', 'barcode scanner', 'tally help'] },
  { page: 'module:bill', name: 'Bill', roles: ['owner', 'office'], words: ['bill module', 'billing module'] },
  { page: 'module:delivery', name: 'Delivery', roles: ['owner', 'office'], words: ['delivery', 'delivery module', 'deliveries'] },
  { page: 'module:sales', name: 'Sales', roles: ['owner', 'office'], words: ['sales module'] },
  { page: 'module:inventory', name: 'Stock', roles: ['owner', 'office'], words: ['inventory', 'inventory module', 'stock module'] },
  { page: 'module:accountant', name: 'Accountant', roles: ['owner', 'office'], words: ['accountant', 'accounts', 'accountant module', 'accounts module', 'accounting', 'collection module', 'collections module'] },
  { page: 'module:payroll', name: 'Payroll', roles: ['owner', 'office'], words: ['payroll', 'payroll module', 'hr'] },
];
function screenFor(text: string, role: Role, exact = false): Reply | null {
  if (exact) {
    text = text.replace(/^((?:open|show|go to|see|view) (?:the |my |all )?)(?:bill|billing)( screen| page)?$/, '$1bills$2'); // "open bill" = "open bills"
    // only a screen's full name: a phrase of 2+ words found whole, or the whole message being that one word
    // polite and long forms ("can you please show me the dues page") come down to the screen's own name
    const bare = text.replace(/^(?:(?:can|could|would) you )?(?:please )?(?:i want to see|i want to open|i want|i need|i would like to see|let me see|let me open|take me to|bring up|pull up|give me|send me|show me|go to|goto|open|show|see|view|need)\s+/, '')
      .replace(/^(?:please )?the\s+/, '').replace(/(\s+(screen|page|please|now|this month|today|for this month|for today|open))+$/, '').trim();
    const said = (w: string) => ` ${bare} `.includes(` ${w} `) || ` ${bare} `.includes(` ${w}s `) || ` ${bare} `.includes(` ${w}es `);
    const hit = SCREENS.filter(s => s.words.some(w => !/[^\x00-\x7f]/.test(w) && (w.includes(' ') ? said(w) : (bare === w || bare === w + 's' || bare === w + 'es'))))
      .sort((a, b) => Math.max(...b.words.filter(said).map(w => w.length), 0) - Math.max(...a.words.filter(said).map(w => w.length), 0));
    if (!hit.length && /\b(open|screen|page|show)\b/.test(text)) {
      const one = bare.replace(/\b(open|screen|page|show|please|the)\b/g, ' ').trim();
      const byName = SCREENS.filter(x => norm(x.name) === one || norm(x.name).split(' ')[0] === one);
      hit.push(...byName);
    }
    const mine = hit.find(h => h.roles.includes(role)) ?? hit[0];
    if (!mine) return null;
    if (!mine.roles.includes(role)) return null; // not this person's screen: let the rest of TESRAX answer
    return opening(mine, text);
  }
  const hit = SCREENS.filter(s => s.words.some(w => text === w || text.startsWith(w + ' ') || text.endsWith(' ' + w) || text.includes(' ' + w + ' ') || (w.length > 5 && text.includes(w))))
    .sort((a, b) => Math.max(...b.words.filter(w => text.includes(w)).map(w => w.length)) - Math.max(...a.words.filter(w => text.includes(w)).map(w => w.length)))
    // two screens matched by the same words ("target": Targets / My day): the one this person may open
    .find((h, _i, all) => { const len = (x: typeof h) => Math.max(...x.words.filter(w => text.includes(w)).map(w => w.length)); const tie = all.filter(x => len(x) === len(all[0])); return tie.includes(h) && (h.roles.includes(role) || !tie.some(x => x.roles.includes(role))); });
  if (!hit) return null;
  if (!hit.roles.includes(role)) return { text: `${hit.name} is the ${hit.roles[0] === 'owner' ? 'owner' : hit.roles[0]}'s screen. Ask them to open it.`, tone: 'warn', refused: true };
  return opening(hit, text);
}
// Collection now lives inside Accountant (14 Nov 2026): "collection module" opens Accountant and says so
function opening(s: { page: string; name: string }, text: string): Reply {
  if (s.page === 'module:accountant' && /\bcollections? module\b/.test(text)) return { text: 'Opening Accountant. Collection, GST and Day close are inside Accountant.', go: s.page };
  return { text: `Opening ${s.name}.`, go: s.page };
}

const has = hasWord;
export const W = {
  help: ['help', 'what can you do', 'what all can you do', 'what can u do', 'what can i ask', 'what can i say', 'options', 'menu', 'commands', 'how to use'],
  stockIn: ['inventory', 'stock in', 'add to stock', 'purchase', 'add this', 'goods received'],
  expense: ['expense', 'eb', 'hire', 'hired', 'loading', 'coolie', 'spent', 'spend', 'diesel', 'petrol', 'fuel', 'toll', 'repair', 'service', 'tyre', 'puncture', 'rent', 'batta', 'salary', 'tea', 'snacks', 'food', 'lunch', 'electricity', 'eb bill', 'current bill', 'power bill', 'internet', 'wifi', 'phone bill', 'mobile recharge', 'recharge', 'wages', 'hamali', 'coolie', 'labour', 'loading charges', 'unloading', 'charges', 'parking', 'courier', 'transport', 'freight', 'lorry', 'stationery', 'printing', 'maintenance', 'water', 'cleaning', 'insurance'],
  bank: ['bank', 'statement', 'match payment'],
  products: ['product list', 'products', 'item master'],
  shops: ['shop list', 'shops list', 'shops', 'retailer list', 'retailers', 'customer list', 'outlets', 'shop master'],
  newShop: ['new shop', 'new outlet', 'add outlet', 'add shop', 'new retailer', 'add retailer', 'new customer', 'add customer', 'add new shop', 'add new retailer'],
  paid: ['paid', 'payment', 'received', 'recd', 'rcvd', 'collected', 'collection', 'gave', 'given', 'got', 'cash', 'upi', 'gpay', 'google pay', 'phonepe', 'paytm', 'cheque', 'chq', 'check', 'neft', 'imps', 'rtgs', 'transfer'],
  ret: ['return', 'returned', 'credit note for', 'credit note to', 'make credit note', 'took back', 'sent back', 'send back', 'gave back', 'give back', 'taken back'],
  damage: ['damage', 'rat', 'rat bite', 'chewed', 'eaten', 'spoilt', 'damaged', 'expired', 'expiry claim', 'leak', 'leaked', 'leaking', 'broken', 'torn', 'crushed', 'wet', 'spoiled', 'udanju', 'udanjiruchu', 'odanju', 'kizhinjiruchu'],
  order: ['order'],
  outstanding: ['outstanding', 'pending', 'owes', 'owe', 'balance', 'due', 'dues', 'has to pay', 'have to pay', 'yet to pay', 'to pay', 'not paid', 'unpaid', 'credit', 'overdue', 'late payment', 'defaulters'],
  sales: ['sales', 'sale today', 'today summary', 'summary', 'sold today', 'sold', 'sell today', 'total sales', 'billing today', 'today billing', 'today s billing', 'how much billed', 'turnover'],
  stock: ['stock of', 'how much stock', 'stock'],
  loadSheet: ['load sheet', 'load list', 'loading list', 'what to load', 'loading'],
  nearExpiry: ['near expiry', 'expiry near', 'short expiry', 'expiring', 'expiry soon', 'expire soon', 'going to expire', 'expiry items'],
  cashHand: ['cash in hand', 'cash with', 'how much cash', 'cash do i have', 'cash balance'],
  tally: ['tally'],
  gstr: ['gstr', 'gst return', 'gstr1', 'gstr-1'],
  einv: ['e-invoice', 'einvoice', 'e invoice', 'irn'],
  claimFile: ['claim file', 'claims file', 'claim report', 'claims report', 'claims for', 'make claim', 'claim export', 'claims export', 'claim excel', 'claims excel', 'claim sheet'],
  needsOk: ['needs ok', 'needs my ok', 'my ok', 'approval', 'approvals', 'waiting', 'orders waiting', 'to approve'],
  openingDues: ['old dues', 'old due', 'opening balance', 'opening balances', 'opening dues', 'old balance', 'old outstanding', 'old bills'],
  openingStock: ['opening stock', 'old stock', 'stock on hand', 'closing stock'],
  scheme: ['scheme', 'offer'],
};

const ROLE_CAN: Record<Role, string[]> = {
  owner: ['*'],
  office: ['*'],
  salesman: ['order', 'payment', 'newshop', 'return', 'outstanding', 'stock', 'help', 'sales'],
  godown: ['purchase', 'claim', 'stock', 'loadsheet', 'expiry', 'help', 'return'],
  delivery: ['payment', 'return', 'help', 'outstanding'],
  cadmin: ['*'],
  manager: ['*'],
  rep: ['order', 'newshop', 'stock', 'help', 'sales', 'expense'],
};

function need(mod: ModuleKey, modules: Record<ModuleKey, boolean>): Reply | null {
  if (modules[mod]) return null;
  const name = MODULES.find(m => m.key === mod)!.name;
  return { text: `${name} is not in your plan yet. Call Hanubix to add it.`, tone: 'warn' };
}

function can(role: Role, what: string) { return ROLE_CAN[role].includes('*') || ROLE_CAN[role].includes(what); }

async function myRole(): Promise<Role> {
  return (await db.staff.get(session().userId))?.role ?? 'owner';
}

export const HELP_TEXT = `Send a file or photo, say what you want, then check the table and tap ✓.
Examples:
• (attach purchase bill photo/Excel) "add this to inventory"
• (attach bank statement Excel) "match payments"
• "Murugan Stores 5 case Surf, 10 Lifebuoy"
• "Murugan Stores paid 2450 cash"
• "van 1 diesel 1500"
• "5 Good Day damaged" · "Selvam return 2 Surf"
• Change what is saved: "Selvam it is not 500, it is 300" · "change Ganapathi order surf to 3 case" · "cancel Murugan payment"
  "cancel Kumar Mart bill" · "diesel was 1400 not 1500" · "physical count surf 90" · "surf rate 115" · "Selvam phone 98…" · "undo"
• "who owes more than 10000" · "today sales" · "how much surf" · "is good day available"
• "load sheet" · "near expiry" · "cash in hand"
• say a screen name to open it: "delivery plan", "approve", "live vans", "day close"
• "HUL Surf 5% off till 30 Nov" · "Good Day buy 24 get 2"
• "tally export" · "gstr1 october" · "e-invoice" · "claim file"
• (attach product or shop list Excel) "add products" / "add shops"
• (attach old dues or opening stock Excel) "old dues" / "opening stock"
Several things at once: "Murugan paid 500, send 2 case surf". After a table you can just say "make it 600", "for Selvam", "add 2 vim", "no".
Short forms, typos and numbers in words work too: "murugan 5k pd", "selvam bal", "rcvd 500 frm kumar mart".`;

/** one request (handle() in converse.ts splits several and links follow-ups) */
export async function handleOne(said: string, files: File[]): Promise<Reply> {
  const textIn = cleanSaid(said); // numbers in words, "5k" and shorthand → plain words
  const text = spokenCodes(norm(textIn));
  learnNames(await db.products.toArray()); // "5 Star", "Total 10": numbers that are part of names in this catalogue
  const settings = await getSettings();
  const mods = (await licenceState(!!ENV_SERVER_URL, settings)).mods; // what the distributor has paid for, never a phone setting
  const role = await myRole();
  const file = files[0];
  if (settings.kind === 'company') return handleCompany(textIn, role); // a brand's head office and team: their own TESRAX

  if (!text && !file) return { text: HELP_TEXT };
  if (has(text, W.help) && !/\breports?\b/.test(text)) return { text: HELP_TEXT }; // "report menu" is the Reports screen
  if (!file && /^(hi+|hello|hey|good (morning|afternoon|evening|night)|how are you|thanks|thank you|ok|okay)( (tesrax|there|you))*$/.test(text)) {
    const me = await db.staff.get(session().userId);
    return { text: `Hello${me ? `, ${me.name.split(' ')[0]}` : ''}! Here's what I can do:\n\n${HELP_TEXT}` };
  }

  // ------------------------ with a file ------------------------
  if (file) {
    if (has(text, W.bank)) {
      if (!can(role, 'bank')) return deny();
      return need('accountant', mods) ?? bankProposal(file);
    }
    // the day a distributor starts: old shop dues and opening stock from the owner's Excel (owner / office only)
    if (isSheet(file) && (has(text, W.openingDues) || has(text, W.openingStock))) {
      if (role !== 'owner' && role !== 'office') return deny();
      const { openingDuesProposal, openingStockProposal } = await import('./opening');
      return has(text, W.openingStock) ? openingStockProposal(file) : openingDuesProposal(file);
    }
    if (has(text, W.products) && isSheet(file)) return importProducts(file);
    if (has(text, W.shops) && isSheet(file)) return importShops(file);
    if (has(text, W.expense)) return expenseFromFile(file, textIn);
    if (has(text, W.damage)) { const r = need('inventory', mods); if (r) return r; return damageProposal(textIn, file); }
    if (has(text, W.order) || has(text, ['diary'])) {
      const r = need('sales', mods) ?? need('inventory', mods); if (r) return r;
      return orderFromPhoto(file, textIn);
    }
    if (!can(role, 'purchase')) return deny();
    const r = need('inventory', mods); if (r) return r;
    return purchaseProposal(file);
  }

  // a minus sign is never read as a plus: "paid -500", "surf -5 damage" ask what was meant. More than 2 decimals in an amount are asked too.
  if (!file) {
    const neg = textIn.match(/(?<![\w/.)])-(?:₹|rs\.?\s*)?\d[\d,]*(?:\.\d+)?/i);
    if (neg) return { text: `I see a minus sign in "${neg[0].replace(/\s+/g, '')}". Did you mean to cancel or undo something? Say it like "cancel Murugan payment" or "undo", or type the number without the minus.`, tone: 'warn' };
    const dec = textIn.replace(/(\d),(\d{3})\b/g, '$1$2').match(/\b\d+\.\d{3,}\b/);
    if (dec && (has(text, W.paid) || has(text, W.expense) || has(text, ['advance']))) return { text: `${dec[0]} has more than 2 decimals. Money is in rupees and paise (2 decimals at most): please type the amount again.`, tone: 'warn' };
  }

  // ------------------------ exports ------------------------
  if (has(text, W.tally)) { if (!can(role, 'accounts')) return deny('The Tally file'); return need('accountant', mods) ?? exportTally(monthIn(text)); }
  if (has(text, W.gstr)) { if (!can(role, 'accounts')) return deny('The GSTR-1 file'); return need('accountant', mods) ?? exportGstr1(monthIn(text)); }
  if (has(text, W.einv)) { if (!can(role, 'accounts')) return deny('The e-invoice file'); return need('accountant', mods) ?? exportEinvoice(monthIn(text)); }
  // "send p&l", "gst summary excel", "day close report", "attendance excel", "trip report excel": the screen's figures as a file
  if (/\b(send|excel|xl|file|download|share|export|whatsapp|mail|email|report|sheet)\b/.test(text) && !/\d{3,}/.test(text)) { const f = await screenFileAsked(text, role); if (f) return f; }
  // "send salary sheet", "salary sheet excel october": the month's salary sheet as Excel (owner)
  if (/\b(salary|salaries|payroll)\b/.test(text) && /\b(send|excel|xl|file|download|share|export|whatsapp|mail|email)\b/.test(text) && !/\d{3,}/.test(text)) return salaryFile(role, text);
  // "outstanding bucket wise", "ageing of outstanding", "debtors ageing", "receivable ageing": dues by age bucket (owner / office)
  if (/\b(outstanding|dues|due|receivable|receivables|debtors|owes|owe|pending payment|balance)\b/.test(text) && /\b(bucket|buckets|bucketwise|ageing|aging|ageing wise|age wise|30 60 90|0 30|30 days|60 days|90 days|days wise|period wise)\b/.test(text)) return duesAgeing(role);
  { const { reportByVoice } = await import('./reportsVoice'); const rr = await reportByVoice(text, role); if (rr) return rr; } // every owner report by name and period
  if (has(text, W.claimFile)) { if (!can(role, 'claims')) return deny(); return need('inventory', mods) ?? exportClaims(monthIn(text)); }

  // ------------------------ a question about profit: answered in words, the P&L one tap away ------------------------
  if (role === 'owner' && /\b(profit|p ?& ?l|pnl|p and l|loss)\b/.test(text) && !/^(open|show|go to|goto|view)\b/.test(text)) {
    const period = /\btoday\b/.test(text) ? 'today' as const : 'month' as const;
    const d = await profitAndLoss(period); const t = pnlTotals(d);
    const top = [...d.expense].sort((a, b) => b.amount - a.amount)[0];
    return {
      text: `${period === 'today' ? 'Today' : 'This month'}: ${t.profit >= 0 ? 'profit' : 'loss'} ${inr(Math.abs(t.profit))}` + (t.income ? ` (${t.pct}% of ${inr(t.income)} income).` : '. No sales yet.') + (top ? ` Biggest cost: ${top.label.toLowerCase()} ${inr(top.amount)}.` : ''),
      tone: t.profit < 0 ? 'warn' : 'ok', link: { label: 'Open P&L', page: 'pnl' },
    };
  }

  // ------------------------ a screen asked for by its exact name ("dead stock", "stock position", "day close") ------------------------
  if (!/\d{2,}/.test(text)) { const sc = screenFor(text, role, true); if (sc) return sc; }
  { const { ordersByVoice } = await import('./tesraxOrders'); const r = await ordersByVoice(text, role); if (r) return r; } // Part 2: download / open / approve an order

  // ------------------------ actions ------------------------
  const shops = (await db.shops.toArray()).filter(s => s.active !== false);
  // a new owner or shop name can contain another shop's word ("Annai owner name Lakshmi"): find the shop without it
  const shopSearch = textIn.replace(/\b(owner(?:\s*name)?|rename|name\s+(?:is|to|change|changed|should|as))\b.*$/i, ' ');
  // a salesman means his own shop on today's beat when a name repeats in other towns
  const today = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
  const found = findShopInText(shops, shopSearch, role === 'salesman' ? { salesmanId: session().userId, day: today } : undefined);
  const shop = found.shop;
  const rest = shop ? findShopInText([shop], textIn).rest : textIn;
  // product names hold everyday words ("Tata Tea", "Intense Repair", "Set Wet"): a clear item line is an order, not an expense or a claim
  const productsAll = (await db.products.toArray()).filter(p => p.active);
  const itemText = shop ? rest : found.ties ? findShopInText([found.ties[0]], textIn).rest : textIn;
  const orderish = parseItemLines(itemText).some(l => l.productText.split(' ').length >= 2 && bestProduct(productsAll, l.productText).score >= 0.9);
  if (!shop && found.ties && (orderish || has(text, W.paid) || has(text, W.outstanding))) {
    const towns = [...new Set(found.ties.map(t => t.area).filter(Boolean))];
    const list = towns.length > 1 ? `${towns.slice(0, -1).join(', ')} or ${towns[towns.length - 1]}` : towns[0] ?? '';
    return { text: `Which ${found.ties[0].name}${list ? ` — ${list}` : ''}? Say the town too, e.g. "${found.ties[0].name} ${towns[0] ?? ''}".`, tone: 'warn', pending: { said: textIn, need: 'shop' } };
  }

  const noOrder = await noOrderVisit(textIn, shop, role, parseItemLines(rest).length > 0); if (noOrder) return noOrder;
  // changing what is already saved: an order, bill, payment, expense, stock count, shop or product, or undo
  const mod = await modifyIntent({ text, textIn, shop, rest, role, products: productsAll, isExpense: has(text, W.expense) && !orderish, isDamage: has(text, W.damage) && !orderish, isOrder: orderish, fixOf: correctionIn });
  if (mod) return mod;
  // "send Murugan Stores statement", "Annai ledger october": the shop's statement, ready to send
  // "send bill SMD/26-27/00005", "print Murugan Stores last bill": the bill ready to print or save as PDF
  { const b = await billAsked(text, shop, role); if (b) return b; }
  if (shop && !orderish && /\b(statement|statements|stmt|ledger|account copy|account statement|soa|khata)\b/.test(text)) return statementReply(shop, role, text);

  if (has(text, W.scheme) && !/\d/.test(text) && /\b(any|what|which|list|running|current|this month|available|show|tell|is there|are there)\b/.test(text)) return schemesTable();
  if ((has(text, W.scheme) || /\d\s*%/.test(textIn) || /buy\s*\d+\s*get\s*\d+/.test(text)) && !has(text, W.claimFile)) { if (role !== 'owner' && role !== 'office') return deny(); return schemeProposal(textIn); }
  if (has(text, W.newShop)) { if (!can(role, 'newshop')) return deny(); return newShopProposal(textIn); }
  if (shop && has(text, W.ret) && !has(text, ['cheque', 'chq', 'upi'])) { if (!can(role, 'return')) return deny(); return returnProposal(shop.id, rest); }
  const expiryOut = /\bexpiry\b/.test(text) && /\d/.test(text) && !/\b(near|soon|list|items|report|going)\b/.test(text); // "6 cake expiry"
  if ((has(text, W.damage) || expiryOut) && !has(text, W.outstanding) && !orderish) { const r = need('inventory', mods); if (r) return r; if (!can(role, 'claim')) return deny(); return damageProposal(textIn); }
  if (!shop && has(text, W.ret) && parseItemLines(textIn).length) return { text: 'Which shop is the return from? Say the shop name.', tone: 'warn', pending: { said: textIn, need: 'shop' } };
  // Corrections in plain words: "it is not 500, it is 300", "300 not 500", "change payment 500 to 300", "wrong, it is 300"
  const fix = correctionIn(text.replace(/\b(van|auto|vehicle|lorry|tempo|bike)\s*\d+\b/g, ' '));
  if (fix) {
    const r = need('collection', mods); if (r) return r;
    if (!can(role, 'payment')) return deny();
    return paymentCorrection(shop?.id, fix.old, fix.next, role, textIn);
  }
  const chq = modeIn(text) === 'cheque' ? chequeIn(rest) : { date: undefined, bank: undefined, rest };
  const payRest = chq.rest; // the cheque's date and bank are not products or amounts
  const restLines = parseItemLines(payRest);
  const productsActive = (await db.products.toArray()).filter(p => p.active);
  // money words are never products ("cash" is not "Cashew")
  const MONEY = new Set([...W.paid, 'rs', 'inr', 'rupees', 'amount', 'from', 'by', 'via', 'ref', 'no', 'number', 'bill', 'bills']);
  const hasProduct = restLines.some(l => { const q = l.productText.split(' ').filter(w => !MONEY.has(w)).join(' '); return !!q && !!bestProduct(productsActive, q).product; });
  const amount = payAmount(payRest);
  // "Selvam paid 450", or just "Selvam 450 rs" / "Velan 5000" (a shop and an amount, nothing else)
  const onlyAmount = amount != null && amount >= 10 && !norm(payRest).replace(/\b(\d+|rs|rupees|inr|only|please|today|from)\b/g, '').trim();
  if (shop && (has(text, W.paid) || onlyAmount) && amount != null && !hasProduct) {
    const r = need('collection', mods); if (r) return r;
    if (!can(role, 'payment')) return deny();
    return paymentProposal(shop.id, amount, modeIn(text), refIn(chq.rest), { chequeDate: chq.date, bank: chq.bank });
  }
  // "received 5 cases lifebuoy from hul": goods came in (stock in), not money
  if (!shop && /\b(received|recieved|got)\b/.test(text) && /\b\d+\s*(case|cases|cs|pcs|pieces|box|boxes|bag|bags|carton|cartons|ctn)\b/.test(text)) { const sc = screenFor('purchases', role, true); if (sc) return sc; }
  if (!shop && has(text, W.paid) && amount != null && !hasProduct && !has(text, W.expense) && !has(text, ['advance', 'salary']))
    return { text: 'Which shop paid? Say the shop name.', tone: 'warn', pending: { said: textIn, need: 'shop' } };
  // Payroll by chat: "leave monday", "leave 12/11 to 14/11 fever", "advance 1000", owner: "Karthik leave tomorrow", "advance 2000 to Ravi"
  if (has(text, ['advance']) && findAmount(text) != null && !shop) return advanceRequest(textIn, role);
  if (has(text, W.expense) && findAmount(text) != null && !shop && !orderish) return expenseFromText(textIn);
  if (has(text, ['leave'])) return leaveRequest(textIn, role);

  if (!shop && /\b(van|vans|auto)\b/.test(text) && /\bwhere\b/.test(text)) { const sc = screenFor('live vans', role, true); if (sc) return sc; }
  if (/\b(came|come|present|absent)\b/.test(text) && (await db.staff.toArray()).some(st => has(text, [norm(st.name.split(' ')[0])]))) { const sc = screenFor('attendance', role, true); if (sc) return sc; }
  if (/\b(van|auto)\s*\d+\s*(details|info|detail)\b/.test(text)) { const sc = screenFor('vans and drivers', role, true); return sc ?? { text: 'Vans & drivers is the owner\'s screen. Ask them to open it.', tone: 'warn', refused: true }; }
  if (/\b(stock received|goods received|new stock|stock came|purchase entry|stock in|stock inward)\b/.test(text) || (!shop && /\breceived\b/.test(text) && /\bfrom\b/.test(text) && !/\b(cash|upi|cheque|payment|money|rs|₹)\b/.test(text)) || (!shop && /\b(stock|goods|load|lorry|items|company|purchase|parcel)\b.*\bcame\b/.test(text))) { const sc = screenFor('purchases', role, true); if (sc) return sc; }

  // ------------------------ questions ------------------------
  if (has(text, W.needsOk)) return needsOkTable(role); // answered in place (founder rule); owner/office get the Open button
  if (role === 'owner' && !shop && /\bcash\b/.test(text) && /\b(staff|salesmen|drivers|who|whom)\b/.test(text)) { const sc = screenFor('cash with staff', role, true); if (sc) return sc; }
  if (has(text, W.cashHand) || (!shop && /\bcash\b/.test(text) && /\bhow much\b/.test(text))) return cashInHand();
  if (has(text, W.loadSheet)) { const r = need('inventory', mods); if (r) return r; const ls = await loadSheet(); return role === 'godown' ? { ...ls, link: { label: 'Open Load vans', page: 'load' } } : ls; }
  if (has(text, W.nearExpiry)) return nearExpiry();
  if (!shop && has(text, W.outstanding) && /\b(pcs|pieces|stock|left|cases|qty)\b/.test(text) && bestProduct(productsActive, text.replace(/\b(balance|pcs|pieces|stock|left|cases|qty|how much|how many)\b/g, ' ').trim()).product)
    return stockTable(text.replace(/\b(balance|pcs|pieces|stock|left|cases|qty|how much|how many)\b/g, ' ').trim());
  if (has(text, W.outstanding)) return outstandingTable(shop?.id, findAmount(text));
  if (/\bstock value\b|\bvalue of (my |the )?stock\b|\bstock worth\b/.test(text)) return stockValue(role);
  if (has(text, W.sales)) return salesToday(text);
  // "how much surf", "is good day available", "how many lifebuoy left"
  if (!shop && /\b(how much|how many|available|left|in stock|stock|quantity|balance stock|do we have|have we got)\b/.test(text)) {
    const q = text.replace(/\b(how much|how many|is|are|available|left|in stock|stock of|stock|check|quantity|balance|do we have|have we got|we have|there|any|of|the|in|at|godown|warehouse|now|today|currently|pieces|pcs|cases|units|qty)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (q && bestProduct(productsActive, q).product) return stockTable(q);
  }

  // ------------------------ orders ------------------------
  const lines = parseItemLines(shop ? rest : textIn);
  // never guess an order from words that aren't products: if nothing matches a product, ask instead
  if (lines.length && shop) {
    const active = productsActive;
    if (!lines.some(l => bestProduct(active, l.productText).product)) {
      // say what was understood and what was not, in two lines (never a page of examples)
      return { text: `Found ${shop!.name}, but ${notProduct(active, lines.map(l => l.productText))}\nSay it like: "${shop!.name} 2 case Surf, 24 Good Day".`, tone: 'warn', missed: true };
    }
  }
  if (shop && lines.length) {
    const r = need('sales', mods) ?? (mods.bill ? null : null); if (r) return r;
    if (!can(role, 'order')) return deny();
    return orderProposal(shop.id, shop ? rest : textIn);
  }
  if (has(text, W.stock)) return stockTable(text.replace(/stock of|how much stock|stock/g, '').replace(/\b(current|please|all|full|today|show|list|items|item|now|details|position|how much|what|is|the)\b/g, ' ').replace(/\s+/g, ' ').trim());
  if (lines.length && !shop && lines.some(l => bestProduct(productsActive, l.productText).product)) {
    return { text: 'Which shop is this order for? Say the shop name, e.g. "Murugan Stores".', tone: 'warn', pending: { said: textIn, need: 'shop' } };
  }
  const sc = /\d/.test(text) && /\b(change|edit|update|set|make|correct|wrong)\b/.test(text) ? null : screenFor(text, role); if (sc) return sc;
  // "Kaveri 3 case coconut oil": cases said, but no shop of ours and no product of ours → the shop is what is missing first
  if (!shop && lines.some(l => l.unit !== 'pcs') && can(role, 'order'))
    return { text: `Which shop is this order for? Say the shop name, e.g. "Murugan Stores".\n${cap(notProduct(productsActive, lines.map(l => l.productText)))}`, tone: 'warn', missed: true, pending: { said: textIn, need: 'shop' } };
  // not understood: a short reply with three things this person can say (the full list only when asked for "help")
  const tries = role === 'salesman' ? ['"Murugan Stores 2 case Surf"', '"Murugan Stores paid 500 cash"', '"my day"']
    : role === 'delivery' ? ['"Kumar Mart paid 1000 cash"', '"diesel 800"', '"my trip"']
    : role === 'godown' ? ['"5 Good Day damaged"', '"how much surf"', '"load sheet"']
    : ['"Murugan Stores 2 case Surf"', '"who owes more than 5000"', '"cancel Kumar Mart bill"'];
  return { text: `I didn't get that. Try ${tries.join(', ')}, or say "help" for everything I can do.`, tone: 'warn', missed: true };
}

// "not 500 … 300", "300 not 500", "500 to 300" (with change/adjust/correct), "wrong … it is 300"
export function correctionIn(t: string): { old?: number; next?: number } | null {
  const N = '(?:₹|rs\\.?\\s*)?(\\d{1,6}(?:\\.\\d{1,2})?)';
  const nums = [...t.replace(/,/g, '').matchAll(/(?:₹|rs\.?\s*)?\b(\d{1,6}(?:\.\d{1,2})?)\b/g)].map(m => Number(m[1])).filter(n => n > 0);
  if (!nums.length) return null;
  const notN = t.match(new RegExp(`\\bnot\\s*${N}\\b`));
  if (notN) { const old = Number(notN[1]); const next = nums.find(n => n !== old); return next ? { old, next } : null; }
  const big = nums.length === 2 && nums.every(n => n >= 100);
  const fixWord = /\b(adjust|correct|correction|change|changed|edit|update|wrong|mistake|actually|actual|instead|should be|typo|fix)\b|\bit was \d/.test(t)
    || (big && new RegExp(`${N}\\s+only\\b`).test(t)); // "8715 amount 8700 only"
  if (!fixWord) return null;
  // "1500 to 1550", "1500 correct to 1550", "752 changed to 725"
  const to = t.match(new RegExp(`${N}\\s+(?:[a-z]+\\s+){0,2}?(?:to|into)\\s+${N}`));
  if (to) return { old: Number(to[1]), next: Number(to[2]) };
  // "it is 300", "should be 300", "actual 1700", "correct amount 2538", "it was 5000"
  const isN = t.match(new RegExp(`\\b(?:it is|it s|its|is|correct is|correct amount is|correct amount|correct|should be|actually|actual|actual amount|is actually|it was|was)\\s*${N}\\b`));
  // "8175 only", "3290 correct"
  const after = t.match(new RegExp(`${N}\\s+(?:nu\\s+)?(?:only|correct|is correct|is right|right)\\b`));
  const next = isN && Number(isN[1]) !== nums[0] ? Number(isN[1]) : after ? Number(after[1]) : isN ? Number(isN[1]) : undefined;
  if (next != null && nums.length >= 2) return { old: nums.find(n => n !== next), next };
  if (nums.length === 2) return { old: nums[0], next: nums[1] }; // "1500 wrong 1700"
  // "annai 9000 wrong": that amount is the wrong one; the right one is asked
  if (nums.length === 1 && new RegExp(`${N}\\s+(?:is\\s+)?(?:wrong|mistake|typo)\\b`).test(t) && !isN) return { old: nums[0] };
  if (nums.length === 1 && !/\b(paid|received|gave|collected)\b/.test(t) && (isN || /\b(wrong|mistake|actually|correct|typo)\b/.test(t) || (/\b(payment|amount)\b/.test(t) && /\b(change|changed|correction|update)\b/.test(t)))) return { next: nums[0] };
  return null;
}

async function paymentCorrection(shopId: string | undefined, old: number | undefined, nextIn: number | undefined, role: Role, said = ''): Promise<Reply> {
  const since = daysFrom(-7);
  const me = session().userId;
  const shopName = shopId ? (await db.shops.get(shopId))?.name ?? 'this shop' : '';
  const pays = (await db.payments.toArray())
    .filter(p => p.status === 'ok' && p.date >= since && (shopId ? p.shopId === shopId : p.collectedBy === me) && (old == null || Math.abs(p.amount - old) < 0.01))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const p = pays[0];
  if (!p) return { text: `I couldn't find a payment${old != null ? ` of ${inr(old)}` : ''}${shopName ? ` for ${shopName}` : ' recorded by you'} in the last 7 days. To change a bill instead, open Bill → Billed → Edit.`, tone: 'warn' };
  if (role !== 'owner' && role !== 'office' && p.collectedBy !== me) return deny();
  if (nextIn == null) return { text: `The ${inr(p.amount)} ${p.mode} payment on ${showDate(p.date)}: what is the correct amount? Say "it is …".`, tone: 'warn', pending: { said, need: 'amount' } };
  const next = nextIn;
  // balances as if the old payment never happened, then the new amount goes to the oldest bills first
  const back = new Map(p.allocations.map(a => [a.invoiceId, a.amount]));
  const bills = (await invoiceBalances(p.shopId)).map(b => ({ b, base: r2(b.balance + (back.get(b.invoice.id) ?? 0)) })).filter(x => x.base > OWED);
  let left = next;
  const rows: Row[] = bills.map(({ b, base }) => { const pay = r2(Math.max(0, Math.min(left, base))); left = r2(left - pay); return { invoiceId: b.invoice.id, number: b.invoice.number, date: b.invoice.date, balance: base, overdue: b.overdueDays ? `${b.overdueDays} days` : '', pay }; });
  const name = (await db.shops.get(p.shopId))?.name ?? '';
  const counted = p.mode === 'cash' && (await db.dayCloses.where('date').equals(p.date).count()) > 0; // only if that day was really closed
  return {
    text: `Correcting the ${p.mode} payment from ${name} on ${showDate(p.date)}: ${inr(p.amount)} → ${inr(next)}. Check and tap ✓.` + (counted ? `\nThis cash was already counted at day close — the ${inr(r2(Math.abs(p.amount - next)))} difference will need to be settled with the person who collected it.` : ''),
    proposal: {
      id: newId(), kind: 'paymentFix', title: 'Correct payment',
      fields: [
        { key: 'shopId', label: 'Shop', type: 'select', options: await shopOptions(), value: p.shopId, readonly: true },
        { key: 'was', label: 'Was ₹', type: 'number', value: p.amount, readonly: true },
        { key: 'amount', label: 'Correct amount ₹', type: 'number', value: next },
        { key: 'mode', label: 'Mode', type: 'select', value: p.mode, options: [{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'cheque', label: 'Cheque' }] },
        { key: 'ref', label: 'UPI / cheque no', value: p.ref ?? '' },
      ],
      columns: [
        { key: 'number', label: 'Bill', readonly: true, width: 150 },
        { key: 'date', label: 'Date', readonly: true, width: 95 },
        { key: 'balance', label: 'Balance ₹', type: 'number', readonly: true, width: 90 },
        { key: 'overdue', label: 'Overdue', readonly: true, width: 80 },
        { key: 'pay', label: 'Pay now ₹', type: 'number', width: 90 },
      ],
      rows, meta: { paymentId: p.id },
    },
  };
}

/** the amount in a payment message: "rs 7500" first; never a cheque/ref number ("cheque no 456123") */
export function payAmount(r: string): number | undefined {
  const t = r.toLowerCase().replace(/(\d),(\d{3})\b/g, '$1$2');
  const rs = t.match(/(?:₹|\brs\.?|\binr)\s*(\d+(?:\.\d{1,2})?)/);
  if (rs) return Number(rs[1]);
  for (const m of t.matchAll(/(?<![\w.])(\d+(?:\.\d{1,2})?)(?![\w])/g)) {
    if (m[1].length >= 6 || /\b(no|ref|number|#)\s*$/.test(t.slice(0, m.index))) continue;
    return Number(m[1]);
  }
  return undefined;
}

function deny(what?: string, ownerOnly = false): Reply { return { text: what ? (ownerOnly ? `${what} is for the owner only. Ask the owner.` : `${what} is done by the owner or office. Ask them, or log in as one of them.`) : 'Your role cannot do this. Ask the owner.', tone: 'warn', refused: true }; }
/** voice typing splits short codes: "GST R", "GST R1", "g s t r" → gstr / gstr1 ("gst" alone stays gst) */
export function spokenCodes(t: string) {
  // common slips of the keyboard, so the words below match ("orders to aprove", "loadsheet")
  t = t.replace(/\b(aprove|approv|aproove|apprve)\b/g, 'approve').replace(/\b(aproval|approvl)\b/g, 'approval').replace(/\bload ?sheets?\b/g, 'load sheet');
  return t.replace(/\bg ?s ?t ?r(?: ?(1|one))?\b/g, (_m, one) => (one ? 'gstr1' : 'gstr'));
}

function monthIn(t: string): string {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const d = new Date(today());
  for (let i = 0; i < 12; i++) {
    if (new RegExp(`\\b${months[i]}`).test(t)) {
      const y = i > d.getMonth() ? d.getFullYear() - 1 : d.getFullYear();
      return `${y}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  if (/last month/.test(t)) { d.setMonth(d.getMonth() - 1); }
  return ymd(d).slice(0, 7);
}
function modeIn(t: string): 'cash' | 'upi' | 'cheque' {
  if (/upi|gpay|phonepe|paytm|google pay/.test(t)) return 'upi';
  if (/cheque|check|chq/.test(t)) return 'cheque';
  return 'cash';
}
function refIn(t: string) { return t.match(/\b(\d{6,12})\b/)?.[1] ?? ''; }

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const BANKS = /\b(state bank|sbi|hdfc|icici|axis|canara|indian bank|iob|indian overseas|union bank|pnb|punjab national|bob|bank of baroda|kotak|tmb|tamilnad mercantile|city union|cub|kvb|karur vysya|idbi|yes bank|federal|bandhan|central bank|uco|ubi|boi|bank of india)\b/i;
const BANK_NAMES: Record<string, string> = { sbi: 'SBI', 'state bank': 'SBI', hdfc: 'HDFC', icici: 'ICICI', axis: 'Axis', canara: 'Canara', 'indian bank': 'Indian Bank', iob: 'IOB', 'indian overseas': 'IOB', 'union bank': 'Union Bank', pnb: 'PNB', 'punjab national': 'PNB', bob: 'Bank of Baroda', 'bank of baroda': 'Bank of Baroda', kotak: 'Kotak', tmb: 'TMB', 'tamilnad mercantile': 'TMB', 'city union': 'City Union', cub: 'City Union', kvb: 'KVB', 'karur vysya': 'KVB', idbi: 'IDBI', 'yes bank': 'Yes Bank', federal: 'Federal', bandhan: 'Bandhan', 'central bank': 'Central Bank', uco: 'UCO', ubi: 'Union Bank', boi: 'Bank of India', 'bank of india': 'Bank of India' };
/** the cheque's own words in a payment message: its date ("25 nov", "nov 25", "25/11"), its bank ("SBI"); `rest` is the message without them
 *  (so the date's digits are never taken as the amount). The cheque number is the 6–12 digits, read by refIn. */
export function chequeIn(t: string): { date?: string; bank?: string; rest: string } {
  let rest = t; let date: string | undefined;
  const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const yearFor = (m: number, d: number, y?: number) => {
    if (y) return iso(y < 100 ? 2000 + y : y, m, d);
    const cand = iso(Number(today().slice(0, 4)), m, d);
    return cand < daysFrom(-120) ? iso(Number(today().slice(0, 4)) + 1, m, d) : cand;
  };
  const mi = (w: string) => MONTHS.split('|').indexOf(w.slice(0, 3).toLowerCase()) + 1;
  let m = rest.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTHS})[a-z]*\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'));
  if (m) date = yearFor(mi(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined);
  else if ((m = rest.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:rs|cases?|pcs))`, 'i')))) date = yearFor(mi(m[1]), Number(m[2]));
  else if ((m = rest.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/))) date = yearFor(Number(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined);
  else if ((m = rest.match(/\b(tomorrow|tmrw|nalaiku|naalaiku|nalai|naalai|nalaikku|naalaikku)\b/i))) date = daysFrom(1);
  if (m) rest = rest.replace(m[0], ' ');
  if (date && !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) date = undefined;
  const b = rest.match(BANKS); const bank = b ? BANK_NAMES[b[1].toLowerCase()] : undefined;
  if (b) rest = rest.replace(b[0], ' ');
  return { date, bank, rest };
}

// ---------------------------------------------------------------------------------------------
async function purchaseProposal(file: File): Promise<Reply> {
  const products = await db.products.toArray();
  let rows: Row[] = [];
  const fields = { companyId: '', billNo: '', date: today(), supplierGstin: '', billTotal: 0 as number };
  let source: 'excel' | 'photo' = 'excel';
  let note = '';
  if (isSheet(file)) {
    const sheet = await readSheet(file);
    const pr = readPurchaseRows(sheet);
    if (!pr) return { text: 'I could not find the item and quantity columns in this sheet. Is it the purchase bill?', tone: 'error' };
    rows = pr.map(x => lineToRow(products, x));
    const h = readBillHeader(sheet);
    Object.assign(fields, { billNo: h.billNo, date: h.date || today(), supplierGstin: h.gstin, billTotal: h.total });
  } else if (isImageOrPdf(file)) {
    source = 'photo';
    if (await looksBlurry(file)) note = 'The photo looks blurry — check every number carefully, or retake it.';
    try {
      const res = await scanFile(file, 'purchase');
      rows = (res.lines ?? []).map(x => lineToRow(products, { item: x.item, code: x.code ?? '', hsn: x.hsn ?? '', batch: x.batch ?? '', expiry: x.expiry ?? '', mrp: x.mrp ?? 0, qty: x.qty, free: x.free ?? 0, rate: x.rate ?? 0, discount: x.discount ?? 0, gst: x.gst ?? 0, amount: x.amount ?? 0 }));
      Object.assign(fields, { billNo: res.billNo ?? '', date: res.date ?? today(), supplierGstin: res.supplierGstin ?? '', billTotal: res.total ?? 0 });
    } catch (e) {
      if (e instanceof NoServerError) {
        note = 'Photo reading needs the Hanubix server, which is not connected yet. Type the items below, or send the bill as Excel.';
        rows = [emptyPurchaseRow()];
      } else return { text: `Could not read the photo: ${(e as Error).message}`, tone: 'error' };
    }
  } else return { text: 'Send a photo, PDF or Excel of the purchase bill.', tone: 'error' };

  // company = the company most matched products belong to
  const counts = new Map<string, number>();
  for (const r of rows) { const p = products.find(x => x.id === r.productId); if (p) counts.set(p.companyId, (counts.get(p.companyId) ?? 0) + 1); }
  fields.companyId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const proposal: Proposal = {
    id: newId(), kind: 'purchase', title: 'Add purchase bill to stock',
    fields: [
      { key: 'companyId', label: 'Company', type: 'select', options: await companyOptions(), value: fields.companyId },
      { key: 'billNo', label: 'Bill no', value: fields.billNo },
      { key: 'date', label: 'Bill date', type: 'date', value: fields.date },
      { key: 'supplierGstin', label: 'Supplier GSTIN', value: fields.supplierGstin },
      { key: 'billTotal', label: 'Bill total ₹', type: 'number', value: fields.billTotal },
    ],
    columns: purchaseColumns(await productOptions()),
    rows, meta: { source, file: file.name }, note,
  };
  const unmatched = rows.filter(r => !r.productId).length;
  return {
    text: `I read ${plural(rows.length, 'item')} from ${file.name}.` + (unmatched ? ` ${plural(unmatched, 'item')} need you to pick the product once — I'll remember next time.` : ''),
    proposal,
  };
}

function purchaseColumns(opts: { value: string; label: string }[]): Col[] {
  return [
    { key: 'item', label: 'Bill says', readonly: true, width: 150 },
    { key: 'productId', label: 'Our product', type: 'select', options: opts, width: 160 },
    { key: 'batch', label: 'Batch', width: 80 },
    { key: 'expiry', label: 'Expiry', type: 'date', width: 120 },
    { key: 'mrp', label: 'MRP', type: 'number', width: 70 },
    { key: 'qty', label: 'Qty (pcs)', type: 'number', width: 70 },
    { key: 'free', label: 'Free', type: 'number', width: 60 },
    { key: 'rate', label: 'Rate', type: 'number', width: 80 },
    { key: 'discount', label: 'Disc ₹', type: 'number', width: 70 },
    { key: 'gst', label: 'GST %', type: 'number', width: 60 },
    { key: 'amount', label: 'Amount', type: 'number', width: 90 },
  ];
}
function emptyPurchaseRow(): Row { return { item: '', code: '', productId: '', batch: '', expiry: '', mrp: 0, qty: 0, free: 0, rate: 0, discount: 0, gst: 0, amount: 0 }; }

function lineToRow(products: Product[], x: { item: string; code: string; hsn: string; batch: string; expiry: string; mrp: number; qty: number; free: number; rate: number; discount: number; gst: number; amount: number }): Row {
  // learned supplier codes first, then name similarity
  const byCode = x.code ? products.find(p => p.code === x.code || p.aliases.includes(x.code)) : undefined;
  const byName = byCode ?? products.find(p => p.aliases.includes(x.item)) ?? bestProduct(products, x.item).product;
  return { item: x.item, code: x.code, hsn: x.hsn, productId: byName?.id ?? '', batch: x.batch, expiry: x.expiry, mrp: x.mrp, qty: x.qty, free: x.free, rate: x.rate, discount: x.discount, gst: x.gst || byName?.gst || 0, amount: x.amount };
}

// ---------------------------------------------------------------------------------------------
async function bankProposal(file: File): Promise<Reply> {
  if (!isSheet(file)) return { text: 'Please send the statement as Excel or CSV (download it from net banking). PDF statements will be read once the server is connected.', tone: 'warn' };
  const rows = readBankRows(await readSheet(file));
  if (!rows) return { text: 'I could not find date / narration / credit columns in this statement.', tone: 'error' };
  const shops = await db.shops.toArray();
  const pays = (await db.payments.toArray()).filter(p => p.mode !== 'cash' && !p.bankLineId && p.status !== 'cancelled');
  const already = new Set((await db.bankLines.toArray()).map(b => `${b.date}|${b.credit}|${b.narration}`));
  const balances = await invoiceBalances();
  const out: Row[] = [];
  for (const r of rows) {
    if (already.has(`${r.date}|${r.credit}|${r.narration}`)) continue; // statement uploaded twice: skip repeats
    if (r.credit <= 0) { out.push({ date: r.date, narration: r.narration, ref: r.ref, credit: 0, debit: r.debit, shopId: '', paymentId: '', why: 'Debit', action: 'ignore' }); continue; }
    let shopId = '', paymentId = '', why = '', action = 'check';
    // 1) UPI/cheque ref recorded by our staff
    const byRef = r.ref ? pays.find(p => p.ref && (r.ref.includes(p.ref) || r.narration.includes(p.ref))) : undefined;
    if (byRef && Math.abs(byRef.amount - r.credit) < 1) { shopId = byRef.shopId; paymentId = byRef.id; why = `Ref ${byRef.ref} recorded by staff`; action = 'match'; }
    // 2) shop name inside narration
    if (!shopId) {
      const f = findShopInText(shops, r.narration);
      if (f.shop) { shopId = f.shop.id; why = 'Shop name in narration'; action = 'match'; }
    }
    // 3) exact amount equals one pending bill
    if (!shopId) {
      const same = balances.filter(b => Math.abs(b.balance - r.credit) < 1);
      if (same.length === 1) { shopId = same[0].invoice.shopId; why = `Equals bill ${same[0].invoice.number}`; action = 'match'; }
      else if (same.length > 1) why = `${plural(same.length, 'bill')} have this amount`;
    }
    // 4) amount equals an unmatched UPI payment
    if (!shopId) {
      const amt = pays.filter(p => Math.abs(p.amount - r.credit) < 1);
      if (amt.length === 1) { shopId = amt[0].shopId; paymentId = amt[0].id; why = 'Same amount as a UPI/cheque entry'; action = 'match'; }
    }
    if (!why) why = 'No match found';
    out.push({ date: r.date, narration: r.narration, ref: r.ref, credit: r.credit, debit: 0, shopId, paymentId, why, action });
  }
  const so = await shopOptions();
  const proposal: Proposal = {
    id: newId(), kind: 'bank', title: 'Match bank statement', fields: [],
    columns: [
      { key: 'date', label: 'Date', readonly: true, width: 95 },
      { key: 'narration', label: 'Narration', readonly: true, width: 220 },
      { key: 'credit', label: 'Credit ₹', type: 'number', readonly: true, width: 90 },
      { key: 'shopId', label: 'Shop', type: 'select', options: so, width: 170 },
      { key: 'why', label: 'Why', readonly: true, width: 160 },
      { key: 'action', label: 'Action', type: 'select', width: 100, options: [{ value: 'match', label: 'Match' }, { value: 'check', label: 'Check' }, { value: 'ignore', label: 'Ignore' }] },
    ],
    rows: out, meta: { statement: file.name },
  };
  const m = out.filter(r => r.action === 'match').length;
  const c = out.filter(r => r.action === 'check').length;
  return { text: `${plural(out.length, 'new line')}. ${m} matched automatically, ${c} need you to check (yellow).`, proposal };
}

// ---------------------------------------------------------------------------------------------
/** a typo ("sarf") gets "did you mean Surf…?"; a product we never stocked ("lux") is plainly "not in your product list" */
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
function notProduct(products: Product[], words: string[]): string {
  return words.map(w => { const c = closeProduct(products, w); return c ? `no product like "${w}" — did you mean ${c.name}?` : `"${w}" is not in your product list.`; }).join(' ');
}
async function orderProposal(shopId: string, itemText: string): Promise<Reply> {
  const products = (await db.products.toArray()).filter(p => p.active);
  const parsed = parseItemLines(itemText);
  const schemes = await db.schemes.toArray();
  const rows: Row[] = [];
  const unknown: string[] = [];
  const unsure: string[] = [];
  for (const l of parsed) {
    const { product, ambiguous } = bestProduct(products, l.productText);
    if (ambiguous) {
      // "surf excel 1kg" fits Easy Wash and Quick Wash: never guess, the person picks (red cell until then)
      const names = ambiguous.slice(0, 4).map(p => p.name);
      unsure.push(l.productText);
      rows.push({ said: `${l.text} — ${names.join(' or ')}${ambiguous.length > 4 ? ` or ${ambiguous.length - 4} more` : ''}`, productId: '', qty: toPieces(l.qty, l.unit, ambiguous[0]), rate: 0, free: 0, amount: 0, stock: '' });
      continue;
    }
    if (!product) { unknown.push(l.productText); rows.push({ said: l.text, productId: '', qty: l.qty, rate: 0, free: 0, amount: 0, stock: '' }); continue; }
    const qty = toPieces(l.qty, l.unit, product);
    rows.push(await orderRow(product, qty, l.text, schemes));
  }
  return {
    text: [unsure.length ? `Which one did you mean for: ${unsure.join(', ')}? Pick it in the table.` : '', unknown.length ? `${cap(notProduct(products, unknown))} Pick the product in the table.` : ''].filter(Boolean).join(' ') || 'Order ready. Check and tap ✓.',
    proposal: {
      id: newId(), kind: 'order', title: 'New order',
      fields: [{ key: 'shopId', label: 'Shop', type: 'select', options: await shopOptions(), value: shopId }],
      columns: [
        // what the owner checks first fits on the phone: product, how many, how much; "you said" is last
        { key: 'productId', label: 'Product', type: 'select', options: (await productOptions()).filter(o => o.value !== '__new'), width: 150 },
        { key: 'qty', label: 'Qty (pcs)', type: 'number', width: 70 },
        { key: 'amount', label: 'Amount', type: 'number', readonly: true, width: 85 },
        { key: 'rate', label: 'Rate', type: 'number', width: 75 },
        { key: 'free', label: 'Free', type: 'number', readonly: true, width: 55 },
        { key: 'stock', label: 'Stock', readonly: true, width: 70 },
        { key: 'said', label: 'You said', readonly: true, width: 130 },
      ],
      rows, meta: {},
    },
  };
}

async function orderFromPhoto(file: File, _text: string): Promise<Reply> {
  try {
    const res = await scanFile(file, 'order');
    const shops = await db.shops.toArray();
    const shop = res.shop ? findShopInText(shops, res.shop).shop : undefined;
    const itemText = (res.lines ?? []).map(l => `${l.qty} ${l.item}`).join(', ');
    if (!shop) return { text: `I read: ${itemText}. Which shop is it for? Type: "<shop name> ${itemText}"`, tone: 'warn' };
    return orderProposal(shop.id, itemText);
  } catch (e) {
    if (e instanceof NoServerError) return { text: 'Reading a diary photo needs the Hanubix server, which is not connected yet. Type the order instead, e.g. "Murugan Stores 5 case Surf".', tone: 'warn' };
    return { text: `Could not read the photo: ${(e as Error).message}`, tone: 'error' };
  }
}

// ---------------------------------------------------------------------------------------------
async function paymentProposal(shopId: string, amount: number, mode: 'cash' | 'upi' | 'cheque', ref: string, chequeWords: { chequeDate?: string; bank?: string } = {}): Promise<Reply> {
  const chequeDate = mode === 'cheque' ? chequeWords.chequeDate ?? today() : undefined;
  const bills = (await invoiceBalances(shopId)).filter(b => b.balance > OWED);
  let left = amount;
  const rows: Row[] = bills.map(b => {
    const pay = r2(Math.max(0, Math.min(left, b.balance)));
    left = r2(left - pay);
    return { invoiceId: b.invoice.id, number: b.invoice.number, date: b.invoice.date, balance: b.balance, overdue: b.overdueDays ? `${b.overdueDays} days` : '', pay };
  });
  return {
    text: (rows.length ? 'Applied to oldest bills first. Change the amounts if the shop wants different bills.' : 'This shop has no pending bills; the money will be kept as advance.') + (chequeDate && chequeDate > today() ? ` Cheque dated ${showDate(chequeDate)}: the bills stay open until then (shown as "cheque to clear").` : ''),
    proposal: {
      id: newId(), kind: 'payment', title: 'Record payment',
      fields: [
        { key: 'shopId', label: 'Shop', type: 'select', options: await shopOptions(), value: shopId, readonly: true },
        { key: 'amount', label: 'Amount ₹', type: 'number', value: amount },
        { key: 'mode', label: 'Mode', type: 'select', value: mode, options: [{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'cheque', label: 'Cheque' }] },
        { key: 'ref', label: 'UPI / cheque no', value: ref },
        ...(mode === 'cheque' ? CHEQUE_FIELDS(chequeDate!, chequeWords.bank ?? '') : []),
      ],
      columns: [
        { key: 'number', label: 'Bill', readonly: true, width: 150 },
        { key: 'date', label: 'Date', readonly: true, width: 95 },
        { key: 'balance', label: 'Balance ₹', type: 'number', readonly: true, width: 90 },
        { key: 'overdue', label: 'Overdue', readonly: true, width: 80 },
        { key: 'pay', label: 'Pay now ₹', type: 'number', width: 90 },
      ],
      rows, meta: {},
    },
  };
}
/** the cheque's own header fields (date written on it, bank) */
export const CHEQUE_FIELDS = (date: string, bank: string) => [
  { key: 'chequeDate', label: 'Cheque date', type: 'date' as const, value: date },
  { key: 'chequeBank', label: 'Bank', value: bank },
];

// ---------------------------------------------------------------------------------------------
async function expenseFromText(textIn: string): Promise<Reply> {
  const t = norm(textIn);
  const vans = (await db.vans.toArray()).filter(v => v.active !== false);
  const me = await db.staff.get(session().userId);
  const van = vans.find(v => t.includes(norm(v.name)) || t.includes(norm(v.number))) ?? (me?.vanId ? vans.find(v => v.id === me.vanId) : undefined);
  return expenseProposal([{ date: today(), category: categoryOf(t), amount: findAmount(vans.reduce((x, v) => x.replace(new RegExp(`\\b${norm(v.name)}\\b`, 'g'), ' ').replace(new RegExp(`\\b${norm(v.number)}\\b`, 'g'), ' '), t).replace(/\b(van|auto|vehicle|lorry|tempo)\s*\d+\b/g, ' ')) ?? 0, vanId: van?.id ?? '', note: textIn }]);
}

async function expenseFromFile(file: File, textIn: string): Promise<Reply> {
  const t = norm(textIn);
  const vans = (await db.vans.toArray()).filter(v => v.active !== false);
  const van = vans.find(v => t.includes(norm(v.name)) || t.includes(norm(v.number)));
  let amount = findAmount(t.replace(/van \d+/, '')) ?? 0;
  let date = today();
  let note = textIn;
  let warn = '';
  try {
    const res = await scanFile(file, 'expense');
    amount = res.amount ?? amount; date = res.date ?? date; note = [res.supplier, textIn].filter(Boolean).join(' · ');
  } catch (e) {
    if (e instanceof NoServerError) warn = 'Photo saved with the expense. Type the amount (photo reading needs the server).';
    else warn = `Could not read the bill: ${(e as Error).message}`;
  }
  const photo = file.type.startsWith('image/') ? await fileToDataUrl(file, 1000, 0.6) : undefined;
  const r = await expenseProposal([{ date, category: categoryOf(t), amount, vanId: van?.id ?? '', note }], photo);
  if (warn) r.text = warn;
  return r;
}

async function expenseProposal(rows: Row[], photo?: string): Promise<Reply> {
  const vans = await db.vans.toArray();
  const cats = ['Fuel', 'Toll', 'Van repair', 'Van hire', 'Batta', 'Salary', 'Rent', 'Electricity', 'Tea & food', 'Loading', 'Other'];
  return {
    text: 'Expense ready. Check and tap ✓.',
    proposal: {
      id: newId(), kind: 'expense', title: 'Record expense', fields: [],
      columns: [
        { key: 'date', label: 'Date', type: 'date', width: 120 },
        { key: 'category', label: 'Category', type: 'select', options: cats.map(c => ({ value: c, label: c })), width: 120 },
        { key: 'amount', label: 'Amount ₹', type: 'number', width: 90 },
        { key: 'vanId', label: 'Van', type: 'select', options: [{ value: '', label: '—' }, ...vans.filter(v => v.active !== false || rows.some(r => r.vanId === v.id)).map(v => ({ value: v.id, label: v.name }))], width: 100 },
        { key: 'note', label: 'Note', width: 200 },
      ],
      rows, meta: { photo },
    },
  };
}

// ---------------------------------------------------------------------------------------------
async function damageProposal(textIn: string, file?: File): Promise<Reply> {
  const products = await db.products.toArray();
  const t = norm(textIn);
  const kind = /expir/.test(t) ? 'expiry' : /transit|van/.test(t) ? 'transit' : 'damage';
  const cleaned = textIn.replace(/damaged|damage|expired|expiry|claim|add to|leak|broken|udanjiruchu|udanju|odanju|kizhinjiruchu/gi, ' ');
  const lines = parseItemLines(cleaned);
  const rows: Row[] = lines.map(l => {
    const p = bestProduct(products, l.productText).product;
    const qty = p ? toPieces(l.qty, l.unit, p) : l.qty;
    return { said: l.text, productId: p?.id ?? '', qty, kind, amount: costValue(p, qty).amount, fromStock: 'yes', note: '' }; // 0 on a staff phone: valued by the owner's phone
  });
  if (!rows.length) rows.push({ said: '', productId: '', qty: 0, kind, amount: 0, fromStock: 'yes', note: '' });
  const photo = file && file.type.startsWith('image/') ? await fileToDataUrl(file, 1000, 0.6) : undefined;
  return {
    text: 'Damage / expiry entry ready. It will go into this month\'s company claim.',
    proposal: {
      id: newId(), kind: 'claim', title: 'Damage / expiry for claim', fields: [],
      columns: [
        { key: 'said', label: 'You said', readonly: true, width: 120 },
        { key: 'productId', label: 'Product', type: 'select', options: (await productOptions()).filter(o => o.value !== '__new'), width: 170 },
        { key: 'qty', label: 'Qty (pcs)', type: 'number', width: 75 },
        { key: 'kind', label: 'Type', type: 'select', width: 100, options: [{ value: 'damage', label: 'Damage' }, { value: 'expiry', label: 'Expiry' }, { value: 'transit', label: 'Transit' }] },
        { key: 'amount', label: 'Value ₹', type: 'number', width: 85 },
        { key: 'fromStock', label: 'Remove from stock', type: 'select', width: 90, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
        { key: 'note', label: 'Note', width: 140 },
      ],
      rows, meta: { photo },
    },
  };
}

async function returnProposal(shopId: string, itemText: string): Promise<Reply> {
  const products = await db.products.toArray();
  const invs = (await db.invoices.where('shopId').equals(shopId).toArray()).filter(i => !i.cancelled).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  const cns = await db.creditNotes.where('shopId').equals(shopId).toArray();
  const rows: Row[] = [];
  // "return 2 surf damaged", "1 vim broken": a damaged word marks that item as not going back to stock (and takes the word out of the product name)
  const DAMAGED = /\b(damaged?|damge|broken|breakage|torn|leak(?:ed|ing|age)?|spoil(?:t|ed)?|crushed|wet|expired|rat\s*bite|chewed|ud[a-z]*nj[a-z]*|od[a-z]*nj[a-z]*|kizhinj[a-z]*)\b/gi;
  const segs = itemText.replace(/return(ed)?/gi, ' ').split(/[,;\n]|\band\b/i);
  const flagged = new Map<string, boolean>();
  const lineList = segs.flatMap(seg => { const bad = new RegExp(DAMAGED.source, 'i').test(seg); return parseItemLines(seg.replace(DAMAGED, ' ')).map(l => { flagged.set(l.text, bad); return l; }); });
  const anyDamaged = [...flagged.values()].some(Boolean);
  for (const l of lineList) {
    const p = bestProduct(products, l.productText).product;
    const qty = p ? toPieces(l.qty, l.unit, p) : l.qty;
    // the latest bill that still has these pieces open (billed minus already returned)
    const open = (i: typeof invs[0]) => p ? openPaid(i, cns.filter(c => c.invoiceId === i.id), p.id) : 0;
    const inv = p ? invs.find(i => open(i) >= qty) ?? invs.find(i => open(i) > 0) : undefined;
    // credit = the bill line's own value of these pieces (taxable + GST), never more than it charged
    let amount = 0; try { amount = inv && p ? await creditValue(inv.id, [{ productId: p.id, paid: Math.min(qty, open(inv)), free: 0, restock: true }]) : 0; } catch { amount = 0; }
    rows.push({ said: l.text, productId: p?.id ?? '', qty, invoiceId: inv?.id ?? '', bill: inv?.number ?? '', amount, restock: flagged.get(l.text) ? 'no' : 'yes' });
  }
  return {
    text: rows.length ? 'Return ready. A credit note will be made against the latest bill with that item.' + (anyDamaged ? ' Damaged pieces do not go back to stock: they go to the claim register.' : '') : 'Say the items, e.g. "Selvam return 2 Surf".',
    proposal: {
      id: newId(), kind: 'return', title: 'Shop return → credit note',
      fields: [
        { key: 'shopId', label: 'Shop', type: 'select', options: await shopOptions(), value: shopId, readonly: true },
        { key: 'reason', label: 'Reason', value: anyDamaged ? 'Return - damaged' : 'Return' },
      ],
      columns: [
        { key: 'said', label: 'You said', readonly: true, width: 110 },
        { key: 'productId', label: 'Product', type: 'select', options: (await productOptions()).filter(o => o.value !== '__new'), width: 160 },
        { key: 'qty', label: 'Qty (pcs)', type: 'number', width: 70 },
        { key: 'bill', label: 'Against bill', readonly: true, width: 140 },
        { key: 'amount', label: 'Credit ₹', type: 'number', width: 85, readonly: true },
        { key: 'restock', label: 'Back to stock', type: 'select', width: 90, options: [{ value: 'yes', label: 'Yes (good)' }, { value: 'no', label: 'No (damaged)' }] },
      ],
      rows, meta: {},
    },
  };
}

async function newShopProposal(textIn: string): Promise<Reply> {
  const name = textIn.replace(/new shop|add shop/gi, '').replace(/[,]/g, ' ').trim();
  return {
    text: 'Fill the shop details. The owner approves new shops before the first bill.',
    proposal: {
      id: newId(), kind: 'newshop', title: 'New shop', fields: [],
      columns: shopColumns(),
      rows: [{ name, owner: '', phone: '', gstin: '', stateCode: '33', area: '', beat: '', creditLimit: 0, creditDays: 7, cashOnly: 'yes', type: 'retail' }], // cash only until the owner sets a limit
      meta: {},
    },
  };
}

async function schemeProposal(textIn: string): Promise<Reply> {
  const t = norm(textIn);
  const companies = await db.companies.toArray();
  const products = await db.products.toArray();
  const company = companies.find(c => t.includes(norm(c.code)) || t.includes(norm(c.name).split(' ')[0]));
  const pct = textIn.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/)?.[1];
  const bg = t.match(/buy\s*(\d+)\s*get\s*(\d+)/);
  const stripped = t.replace(/scheme|offer|buy\s*\d+\s*get\s*\d+|\d+(\.\d+)?\s*(%|percent)|off|till.*|to \d.*/g, ' ')
    .replace(company ? new RegExp(`${norm(company.code)}|${norm(company.name).split(' ')[0]}`, 'g') : /$^/, ' ').trim();
  const prod = stripped ? bestProduct(products.filter(p => !company || p.companyId === company.id), stripped).product : undefined;
  const till = textIn.match(/(?:till|to|until)\s+(\d{1,2}[/\-. ][0-9A-Za-z]{1,3}(?:[/\-. ]\d{2,4})?)/i)?.[1];
  let to = daysFrom(30);
  if (till) { const d = toIsoDate(/\d{2,4}$/.test(till) && till.split(/[/\-. ]/).length === 3 ? till : `${till} ${new Date().getFullYear()}`); if (d) to = d; }
  const row: Row = {
    companyId: company?.id ?? prod?.companyId ?? '', productId: prod?.id ?? '', name: textIn.slice(0, 40),
    type: bg ? 'free' : 'pct', value: pct ? Number(pct) : 0, buyQty: bg ? Number(bg[1]) : 0, freeQty: bg ? Number(bg[2]) : 0,
    from: today(), to, source: 'company', combine: 'add',
  };
  return {
    text: 'Scheme ready. Company schemes are claimed back automatically every month.',
    proposal: {
      id: newId(), kind: 'schemes', title: 'Add scheme', fields: [],
      columns: [
        { key: 'companyId', label: 'Company', type: 'select', options: await companyOptions(), width: 120 },
        { key: 'productId', label: 'Product (blank = all)', type: 'select', options: [{ value: '', label: 'All products' }, ...(await productOptions()).filter(o => o.value && o.value !== '__new')], width: 170 },
        { key: 'name', label: 'Name', width: 150 },
        { key: 'type', label: 'Type', type: 'select', width: 90, options: [{ value: 'pct', label: '% off' }, { value: 'free', label: 'Buy X get Y' }] },
        { key: 'value', label: '%', type: 'number', width: 55 },
        { key: 'buyQty', label: 'Buy (pcs)', type: 'number', width: 65 },
        { key: 'freeQty', label: 'Free (pcs)', type: 'number', width: 65 },
        { key: 'from', label: 'From', type: 'date', width: 120 },
        { key: 'to', label: 'To', type: 'date', width: 120 },
        { key: 'source', label: 'Given by', type: 'select', width: 100, options: [{ value: 'company', label: 'Company' }, { value: 'own', label: 'Our own' }] },
        { key: 'combine', label: 'With other schemes', type: 'select', width: 100, options: [{ value: 'add', label: 'Add on' }, { value: 'replace', label: 'Replace' }] },
      ],
      rows: [row], meta: {},
    },
  };
}

function shopColumns(): Col[] {
  return [
    { key: 'name', label: 'Shop name', width: 150 },
    { key: 'owner', label: 'Owner', width: 100 },
    { key: 'phone', label: 'Mobile', width: 110 },
    { key: 'gstin', label: 'GSTIN (if B2B)', width: 150 },
    { key: 'stateCode', label: 'State', type: 'select', width: 120, options: Object.entries(STATES).map(([value, label]) => ({ value, label: `${value} ${label}` })) },
    { key: 'area', label: 'Area', width: 100 },
    { key: 'beat', label: 'Beat (day)', width: 90 },
    { key: 'creditLimit', label: 'Credit limit ₹', type: 'number', width: 90 },
    { key: 'creditDays', label: 'Credit days', type: 'number', width: 70 },
    { key: 'cashOnly', label: 'Cash only', type: 'select', width: 70, options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] },
    { key: 'type', label: 'Type', type: 'select', width: 110, options: [{ value: 'retail', label: 'Retail' }, { value: 'wholesale', label: 'Wholesale' }, { value: 'subdistributor', label: 'Sub-distributor' }] },
  ];
}

async function importProducts(file: File): Promise<Reply> {
  const rows = readProductRows(await readSheet(file));
  if (!rows) return { text: 'I could not find a product name column.', tone: 'error' };
  const companies = await db.companies.toArray();
  const existing = await db.products.toArray();
  return {
    text: `${plural(rows.length, 'product')} read. Check company, HSN, GST and rates.`,
    proposal: {
      id: newId(), kind: 'products', title: 'Import products', fields: [],
      columns: [
        { key: 'name', label: 'Name', width: 170 },
        { key: 'companyId', label: 'Company', type: 'select', options: await companyOptions(), width: 110 },
        { key: 'companyName', label: 'New company', width: 120 },
        { key: 'code', label: 'Code', width: 80 },
        { key: 'hsn', label: 'HSN', width: 70 },
        { key: 'gst', label: 'GST %', type: 'number', width: 60 },
        { key: 'mrp', label: 'MRP', type: 'number', width: 70 },
        { key: 'rate', label: 'Sell rate', type: 'number', width: 80 },
        { key: 'purchaseRate', label: 'Buy rate', type: 'number', width: 80 },
        { key: 'caseSize', label: 'Pcs/case', type: 'number', width: 70 },
      ],
      rows: rows.map(r => {
        const c = companies.find(x => r.company && (norm(x.name).includes(norm(r.company)) || norm(r.company).includes(norm(x.code))));
        const ex = existing.find(p => norm(p.name) === norm(r.name));
        // a company not on this phone yet (new distributor) is created when the table is approved
        return { id: ex?.id ?? '', name: r.name, companyId: c?.id ?? '', companyName: c ? '' : r.company.trim(), code: r.code, hsn: r.hsn, gst: r.gst, mrp: r.mrp, rate: r.rate, purchaseRate: r.purchase, caseSize: r.caseSize };
      }),
      meta: {},
    },
  };
}

async function importShops(file: File): Promise<Reply> {
  const rows = readShopRows(await readSheet(file));
  if (!rows) return { text: 'I could not find a shop name column.', tone: 'error' };
  return {
    text: `${plural(rows.length, 'shop')} read. Check GSTIN and credit terms.`,
    proposal: {
      id: newId(), kind: 'shops', title: 'Import shops', fields: [], columns: shopColumns(),
      rows: rows.map(r => ({ ...r, stateCode: '33', cashOnly: Number(r.creditLimit) > 0 ? 'no' : 'yes', type: 'retail' })), meta: {},
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Questions → read-only tables (always downloadable as Excel)
async function outstandingTable(shopId?: string, above?: number): Promise<Reply> {
  const shops = await db.shops.toArray();
  const rows: (string | number)[][] = [];
  const dues = await allOutstanding(); // one pass over the bills (1,200 shops)
  for (const s of shops.filter(x => !shopId || x.id === shopId)) {
    const o = dues.get(s.id);
    if (o && o.total > OWED && (!above || o.total >= above)) rows.push([s.name, s.area, o.total, o.overdue, o.maxOverdueDays, o.bills]);
  }
  rows.sort((a, b) => Number(b[2]) - Number(a[2]));
  const total = r2(rows.reduce((a, r) => a + Number(r[2]), 0));
  return {
    text: rows.length ? `${plural(rows.length, 'shop')} owe ${inr(total)} in total.` : 'Nobody owes anything. 🎉',
    table: { name: 'Outstanding', columns: ['Shop', 'Area', 'Pending ₹', 'Overdue ₹', 'Max days overdue', 'Bills'], rows },
  };
}

/** P&L, GST summary, day close, attendance and trips as files (the figures of their screens) */
async function screenFileAsked(text: string, role: Role): Promise<Reply | null> {
  const F = await import('./screenFiles');
  const { periodIn } = await import('./reportsVoice');
  const fileWord = /\b(send|excel|xl|file|download|share|export|whatsapp|mail|email)\b/.test(text);
  let made: Awaited<ReturnType<typeof F.pnlFile>> | null = null, who: Role[] = ['owner', 'office'], what = '';
  if (/\b(p ?(&|and|n)? ?l|pnl|profit and loss|profit loss|profit)\b/.test(text) && (fileWord || /\b(p ?l|pnl|profit and loss) (report|sheet)\b/.test(text))) { who = ['owner']; what = 'The P&L'; if (role === 'owner') made = await F.pnlFile(/\btoday\b/.test(text) ? 'today' : 'month'); }
  else if (/\b(gst|tax) (summary|report|rpt|status)\b/.test(text) && fileWord) { /* "gst report" alone opens the GST screen */ what = 'The GST summary'; if (who.includes(role)) made = await F.gstSummaryFile(periodIn(text).month ?? today().slice(0, 7)); }
  else if (/\b(day close|dayclose|day closing|closing|day summary|day end|end of day)\b/.test(text)) { who = ['owner']; what = 'The day close'; if (role === 'owner') made = await F.dayCloseFile(/\byesterday\b/.test(text) ? (await import('./db')).daysFrom(-1) : today()); }
  else if (/\b(attendance|attendence|attndnce|who came)\b/.test(text) && (fileWord || /\b(report|sheet|register)\b/.test(text))) { what = 'Attendance'; if (who.includes(role)) { const p = periodIn(text); const oneDay = /\b(today|yesterday)\b/.test(text) || !/\b(month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(text); made = await F.attendanceFile(oneDay ? p.from : null, p.month ?? today().slice(0, 7)); } }
  else if (/\b(trip|trips|km|kilometre|kilometer|van) (report|reports|sheet)\b|\btrip report/.test(text) && fileWord) { what = 'Trip reports'; if (who.includes(role)) made = await F.tripFile(); }
  else return null;
  if (!who.includes(role)) return deny(what, who.length === 1);
  if (!made) return null;
  const f = made;
  return { text: f.text, actions: [{ label: 'Send as Excel', run: () => { void F.sendFile(f); } }] };
}

/** outstanding by age bucket: one row a shop, 0–30 / 31–60 / 61–90 / 90+ days, advance taken off; the table's Excel sends it */
async function duesAgeing(role: Role): Promise<Reply> {
  if (role !== 'owner' && role !== 'office') return deny('Outstanding by age');
  const { receivablesAgeing } = await import('./ledger');
  const a = await receivablesAgeing(), t = a.totals;
  return {
    text: `Outstanding by age: ${inr(t.total)} from ${plural(a.rows.length, 'shop')} — 0–30 days ${inr(t.b0_30)}, 31–60 ${inr(t.b31_60)}, 61–90 ${inr(t.b61_90)}, over 90 days ${inr(t.b90)}${t.advance ? `, less advances ${inr(t.advance)}` : ''}.`,
    table: { name: `Outstanding-by-age-${today()}`, columns: ['Shop', 'Area', '0–30 days', '31–60 days', '61–90 days', '90+ days', 'Advance', 'Total'],
      rows: [...a.rows.map(r => [r.shop, r.area, r.b0_30, r.b31_60, r.b61_90, r.b90, r.advance ? -r.advance : 0, r.total]), ['Total', '', t.b0_30, t.b31_60, t.b61_90, t.b90, t.advance ? -t.advance : 0, t.total]] },
    link: { label: 'Open Outstanding', page: 'outstanding' },
  };
}

/** the salary sheet of a month as Excel (owner only; before the 11th it is last month's, as on the Payroll screen) */
async function salaryFile(role: Role, text: string): Promise<Reply> {
  if (role !== 'owner') return deny('The salary sheet', true);
  const { periodIn } = await import('./reportsVoice');
  const { salarySheet, SALARY_HEADER, salaryCells } = await import('./payroll');
  const { downloadSheet } = await import('./readers');
  const named = /\b(this month|last month|previous month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/.test(text);
  const cur = today().slice(0, 7), prev = (await import('./reports')).prevMonth(cur);
  const month = named ? (periodIn(text).month ?? cur) : Number(today().slice(8)) <= 10 ? prev : cur;
  const rows = await salarySheet(month);
  const net = r2(rows.reduce((a, r) => a + r.net, 0));
  return {
    text: `Salary sheet ${showMonth(month)}: ${plural(rows.length, 'person', 'people')}, net to pay ${inr(net)}.`,
    actions: rows.length ? [{ label: 'Send salary sheet (Excel)', run: () => { void downloadSheet(`salary-${month}`, SALARY_HEADER, salaryCells(rows), true, 'salary'); } }] : undefined,
    link: { label: 'Open Salary', page: 'salary' },
  };
}

/** a bill asked for by number, or a shop's last bill, with print / send / pdf / show words */
async function billAsked(text: string, shop: Shop | undefined, role: Role): Promise<Reply | null> {
  if (!/\b(print|reprint|send|share|pdf|whatsapp|copy|show|open|resend)\b/.test(text)) return null;
  const tail = text.match(/\b[a-z]{1,6} \d{2} \d{2} (\d{1,6})\b/)?.[1] ?? text.match(/\b(?:bill|invoice) (?:no |number )?0*(\d{1,6})\b/)?.[1];
  const wantsLast = !!shop && /\b(last|latest|recent|todays|today s|previous) (bill|invoice)\b|\b(bill|invoice) of\b/.test(text);
  if (!tail && !wantsLast) return null;
  if (role === 'godown') return deny('Printing or sending a bill');
  const all = (await db.invoices.toArray()).filter(i => !i.cancelled);
  const inv = tail
    ? all.filter(i => Number(i.number.match(/(\d+)$/)?.[1]) === Number(tail) && (!shop || i.shopId === shop.id)).sort((a, b) => b.date.localeCompare(a.date))[0]
    : all.filter(i => i.shopId === shop!.id).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))[0];
  if (!inv) return { text: tail ? `I couldn't find bill number ${tail}. Say the number on the bill, e.g. "send bill SMD/26-27/00005".` : `${shop!.name} has no bills yet.`, tone: 'warn' };
  const sh = await db.shops.get(inv.shopId);
  return {
    text: `Bill ${inv.number} · ${sh?.name ?? ''} · ${inr(inv.total)} · ${inv.date.split('-').reverse().join('-')}. Tap to print, or save as PDF and send.`,
    actions: [{ label: 'Open bill — print / PDF', run: () => { window.dispatchEvent(new CustomEvent('hanubix:print-bill', { detail: { invoiceId: inv.id } })); } }],
  };
}

/** a shop's statement: balance in words, the Excel one tap away (not the godown) */
async function statementReply(shop: Shop, role: Role, text: string): Promise<Reply> {
  if (role === 'godown') return deny('A shop statement');
  const { shopStatement, sendStatement } = await import('./statement');
  const { periodIn } = await import('./reportsVoice');
  const named = /\b(today|yesterday|week|month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|90 days|quarter)\b/.test(text);
  const per = named ? periodIn(text) : null;
  const d = await shopStatement(shop.id); if (!d) return { text: 'Shop not found.', tone: 'error' };
  return {
    text: `${shop.name}: balance due ${inr(Math.max(0, d.due.total))}` + (d.due.overdue > 0 ? `, overdue ${inr(d.due.overdue)}` : '') + (d.due.advance > 0 ? `, advance ${inr(d.due.advance)}` : '') + `. ${plural(d.rows.length, 'entry', 'entries')}${per ? ` — statement for ${per.label}` : ''}.`,
    actions: d.rows.length ? [{ label: 'Send statement (Excel)', run: () => { void sendStatement(shop.id, per?.from, per?.to); } }] : undefined,
  };
}

/** "what is my stock value": the stock on hand at purchase rate (owner / office / godown) */
async function stockValue(role: Role): Promise<Reply> {
  if (role !== 'owner' && role !== 'office' && role !== 'godown') return deny('Stock value');
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const lots = (await db.batches.toArray()).filter(b => b.qty > 0);
  let value = 0, unpriced = 0; const items = new Set<string>();
  for (const b of lots) { const r = products.get(b.productId)?.purchaseRate; items.add(b.productId); if (typeof r === 'number' && r > 0) value += b.qty * r; else unpriced++; }
  return { text: `Stock value at purchase rate: ${inr(r2(value))} across ${plural(items.size, 'product')} (before GST).` + (unpriced ? ` ${plural(unpriced, 'lot')} without a purchase rate ${unpriced === 1 ? 'is' : 'are'} not counted.` : ''), link: { label: 'Open Stock position', page: 'stock' } };
}

async function salesToday(text = ''): Promise<Reply> {
  // "last month sales", "sales october", "this month sales": the figures of that period (net of returns, before GST), the Reports screen one tap away
  const wantsMonth = /\blast month\b|\bthis month\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.test(text) && !/\btoday\b/.test(text);
  if (wantsMonth) {
    const per = /\blast month\b/.test(text) ? period('last') : /\bthis month\b/.test(text) ? period('month') : period('pick', monthIn(text));
    const sm = await salesSummary(per);
    return {
      text: `${/\blast month\b/.test(text) ? `Last month (${per.label})` : per.label}: ${plural(sm.bills, 'bill')}, net sales ${inr(sm.net.taxable)} before GST, after returns (${inr(sm.net.total)} with GST)` + (sm.notes ? `; ${plural(sm.notes, 'credit note')} ${inr(sm.credited.total)} taken off.` : '.'),
      link: { label: 'Open Reports', page: 'reports' },
    };
  }
  const d = today();
  const invs = (await db.invoices.where('date').equals(d).toArray()).filter(i => !i.cancelled);
  const pays = (await db.payments.where('date').equals(d).toArray()).filter(p => p.status === 'ok');
  const companies = new Map((await db.companies.toArray()).map(c => [c.id, c.name]));
  const staff = new Map((await db.staff.toArray()).map(s => [s.id, s.name]));
  const orders = new Map((await db.orders.toArray()).map(o => [o.id, o]));
  const byKey = new Map<string, { bills: number; amount: number }>();
  for (const i of invs) {
    const sm = staff.get(orders.get(i.orderId ?? '')?.salesmanId ?? '') ?? 'Office';
    const k = `${companies.get(i.companyId)}|${sm}`;
    const v = byKey.get(k) ?? { bills: 0, amount: 0 };
    v.bills++; v.amount = r2(v.amount + i.total); byKey.set(k, v);
  }
  const rows = [...byKey.entries()].map(([k, v]) => [...k.split('|'), v.bills, v.amount]);
  const fig = await dayFigures(d); // the same billed / collected figures as Day close
  void pays;
  return {
    text: `Today: ${plural(invs.length, 'bill')}, sales ${inr(fig.sales)} (after cancelled and credited bills), collected ${inr(fig.collected)}` + (fig.chequesToClear > 0 ? `, cheques to clear ${inr(fig.chequesToClear)}.` : '.'),
    table: { name: `Sales ${d}`, columns: ['Company', 'Salesman', 'Bills', 'Amount ₹'], rows },
  };
}

async function stockTable(q: string): Promise<Reply> {
  const products = (await db.products.toArray()).filter(p => p.active);
  const co = q ? (await db.companies.toArray()).find(c => has(q, [norm(c.code), norm(c.name).split(' ')[0]])) : undefined;
  const list = co ? products.filter(p => p.companyId === co.id) : q ? products.filter(p => bestProduct([p], q).product) : products;
  const batches = await db.batches.toArray();
  const rows = list.map(p => {
    const bs = batches.filter(b => b.productId === p.id && b.qty > 0 && b.expiry >= today()).sort((a, b) => a.expiry.localeCompare(b.expiry));
    const qty = bs.reduce((a, b) => a + b.qty, 0);
    return [p.name, qty, cases(qty, p.caseSize), bs[0]?.expiry ?? '', r2(qty * p.purchaseRate)];
  });
  if (q && !rows.length) return { text: `No product matches "${q}". Say the product name, e.g. "surf stock".`, tone: 'warn' };
  return { text: `Stock of ${plural(rows.length, 'product')}.`, table: { name: 'Stock', columns: ['Product', 'Pieces', 'Cases', 'Oldest expiry', 'Value ₹'], rows } };
}

export async function loadSheet(): Promise<Reply> {
  const invs = (await db.invoices.where('deliveryStatus').equals('pending').toArray()).filter(i => !i.cancelled);
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const total = new Map<string, { qty: number; batches: Map<string, number> }>();
  for (const i of invs) for (const l of i.lines) {
    const v = total.get(l.productId) ?? { qty: 0, batches: new Map() };
    v.qty += l.qty + l.freeQty;
    for (const b of l.batches) v.batches.set(`${b.batch} (exp ${b.expiry})`, (v.batches.get(`${b.batch} (exp ${b.expiry})`) ?? 0) + b.qty);
    total.set(l.productId, v);
  }
  const rows = [...total.entries()].map(([pid, v]) => {
    const p = products.get(pid)!;
    return [p.name, v.qty, cases(v.qty, p.caseSize), [...v.batches.entries()].map(([b, q]) => `${b}: ${q}`).join('; ')];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { text: `Load sheet for ${plural(invs.length, 'bill')} waiting for delivery. Pick oldest batch first.`, table: { name: 'Load sheet', columns: ['Product', 'Pieces', 'Cases', 'Batches (oldest first)'], rows } };
}

async function nearExpiry(): Promise<Reply> {
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const limit = daysFrom(60);
  const rows = (await db.batches.toArray()).filter(b => b.qty > 0 && b.expiry <= limit).sort((a, b) => a.expiry.localeCompare(b.expiry))
    .map(b => [products.get(b.productId)?.name ?? '', b.batch, b.expiry, b.qty, b.expiry < today() ? 'EXPIRED' : 'Push sale']);
  return { text: rows.length ? `${rows.length} batch(es) expire within 60 days.` : 'Nothing expires in the next 60 days.', table: { name: 'Near expiry', columns: ['Product', 'Batch', 'Expiry', 'Pieces', 'Action'], rows } };
}

export async function cashInHand(): Promise<Reply> {
  const pays = (await db.payments.toArray()).filter(p => p.mode === 'cash' && !p.settled && p.status === 'ok');
  const staff = new Map((await db.staff.toArray()).map(s => [s.id, s.name]));
  const by = new Map<string, { amt: number; n: number; oldest: string }>();
  for (const p of pays) {
    const v = by.get(p.collectedBy) ?? { amt: 0, n: 0, oldest: p.date };
    v.amt = r2(v.amt + p.amount); v.n++; if (p.date < v.oldest) v.oldest = p.date; by.set(p.collectedBy, v);
  }
  const rows = [...by.entries()].map(([id, v]) => [staff.get(id) ?? id, v.amt, v.n, v.oldest]);
  return { text: rows.length ? `${inr(r2(rows.reduce((a, r) => a + Number(r[1]), 0)))} cash is with staff, not yet handed to office.` : 'No cash pending with staff.', table: { name: 'Cash in hand', columns: ['Staff', 'Cash ₹', 'Payments', 'Since'], rows } };
}

async function schemesTable(): Promise<Reply> {
  const d = today();
  const companies = new Map((await db.companies.toArray()).map(c => [c.id, c.name]));
  const products = new Map((await db.products.toArray()).map(p => [p.id, p.name]));
  const rows = (await db.schemes.toArray()).filter(x => x.from <= d && x.to >= d)
    .map(x => [companies.get(x.companyId) ?? '', x.productId ? products.get(x.productId) ?? '' : 'All products', x.type === 'free' ? `Buy ${x.buyQty} get ${x.freeQty}` : `${x.value}% off`, x.to]);
  return { text: rows.length ? `${plural(rows.length, 'scheme')} running today. They apply on every bill automatically.` : 'No scheme is running today.', table: { name: 'Schemes', columns: ['Company', 'Product', 'Offer', 'Till'], rows } };
}

async function needsOkTable(role?: Role): Promise<Reply> {
  // every order still to approve: new ones and the ones a check stopped (needs OK); a salesman sees only his own
  const boss = role === 'owner' || role === 'office' || !role;
  const all = [...await db.orders.where('status').equals('new').toArray(), ...await db.orders.where('status').equals('needs_ok').toArray()];
  const orders = boss ? all : all.filter(o => o.salesmanId === session().userId);
  const shops = new Map((await db.shops.toArray()).map(s => [s.id, s.name]));
  const text = boss
    ? (orders.length ? `${plural(orders.length, 'order')} wait for your OK.` : 'Nothing waiting for your OK.')
    : (orders.length ? `${plural(orders.length, 'order')} of yours wait for the owner's OK.` : 'None of your orders is waiting for the owner\'s OK.');
  return { text, ...(boss ? { link: { label: 'Open Orders received', page: 'orders-received' } } : {}), table: { name: 'Needs OK', columns: ['Shop', 'Date', 'Items', 'Why'], rows: orders.map(o => [shops.get(o.shopId) ?? '', showDate(o.date), o.lines.length, o.issues.join('; ')]) } };
}


// ---------------- Payroll by chat ----------------
// while a message with several requests is being split, each part is tried without saving anything: nothing in TESRAX saves
// before ✓ any more (an advance is a table too), so there is nothing to hold back; kept so the splitter's call stays valid
export function setDry(_dry: boolean) { /* nothing is saved before ✓ */ }
function parseDate(t: string): string | null {
  const m = t.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (m) { const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : today().slice(0, 4); return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (TOMORROW.test(t)) return daysFrom(1);
  if (TODAY.test(t)) return today();
  for (let i = 0; i < 7; i++) if (new RegExp(`\\b${days[i]}\\b`).test(t)) { const d = new Date(); const diff = (i - d.getDay() + 7) % 7 || 7; return daysFrom(diff); }
  return null;
}
// "nalaiku leave" is tomorrow, "inniku" today (it used to be read as today with the reason "nalaiku")
const TOMORROW = /\b(tomorrow|tmrw|tmr|nalaiku|naalaiku|nalai|naalai|nalaikku|naalaikku)\b/;
const TODAY = /\b(today|inniku|innaiku|indru|innikku)\b/;
/** a day is said in this message (the answer to "Which day?") */
export function dayIn(t: string) { return /\d{1,2}[\/-]\d{1,2}/.test(t) ? parseDate(t) : parseDate(norm(t)); }
async function whom(t: string, role: Role): Promise<Staff | undefined> {
  const staff = (await db.staff.toArray()).filter(s => s.active);
  if (role === 'owner' || role === 'office') { const hit = staff.find(s => s.role !== 'owner' && t.includes(norm(s.name.split(' ')[0]))); if (hit) return hit; }
  return staff.find(s => s.id === session().userId);
}
// Leave always comes as the check-and-✓ table with the day in words. Nothing is saved before ✓, a day is never guessed.
async function leaveRequest(textIn: string, role: Role): Promise<Reply> {
  const t = norm(textIn);
  // "Ravi leave approve", "ok Ravi leave": the owner wants to approve a request, not to make a new leave
  if ((role === 'owner' || role === 'office') && /\b(approve|approved|ok|okay|accept|sanction)\b/.test(t)) return { text: 'Opening Payroll → Today. Leave requests are approved there.', go: 'today' };
  const who = await whom(t, role); if (!who) return { text: 'Who is the leave for?', tone: 'warn' };
  // dates read before the words are normalised (norm() turns "12/11" into "12 11": the day was lost and today taken)
  const dates = [...textIn.matchAll(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/g)].map(m => parseDate(m[0])!);
  const from = dates[0] ?? parseDate(t);
  if (!from) return { text: `Which day is the leave${who.id === session().userId ? '' : ` for ${who.name.split(' ')[0]}`}? Say e.g. "tomorrow", "Monday" or "16/11".`, tone: 'warn', pending: { said: textIn, need: 'date' } };
  const to = dates[1] && dates[1] >= from ? dates[1] : from;
  const first = norm(who.name.split(' ')[0]);
  const reason = norm(textIn.replace(/\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?/g, ' '))
    .replace(new RegExp(`\\b(${first}|leave|leaves|i|want|need|am|on|is|for|to|from|till|until|day|days|please|pls|plz|sir|madam|give|apply|take|taking|and|${TOMORROW.source.slice(3, -3)}|${TODAY.source.slice(3, -3)}|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b`, 'g'), ' ')
    .replace(/\s+/g, ' ').trim() || 'personal';
  const self = who.id === session().userId;
  const status = self && role !== 'owner' ? 'waiting' : 'approved';
  const staff = (await db.staff.toArray()).filter(s => s.active && s.role !== 'owner');
  const when = `${showDay(from)}${to !== from ? ` to ${showDay(to)}` : ''}`;
  return {
    text: status === 'waiting' ? `Leave ${when} (${reason}). Check and tap ✓ to send it to the owner.` : `${who.name.split(' ')[0]}: leave ${when} (${reason}). Check and tap ✓.`,
    proposal: {
      id: newId(), kind: 'leave', title: 'Leave',
      fields: [
        { key: 'staffId', label: 'Who', type: 'select', readonly: self, options: (self ? [who] : staff).map(s => ({ value: s.id, label: s.name })), value: who.id },
        { key: 'reason', label: 'Reason', value: reason },
      ],
      columns: [{ key: 'from', label: 'From', type: 'date', width: 140 }, { key: 'to', label: 'To', type: 'date', width: 140 }],
      rows: [{ from, to }],
      meta: { status },
    },
  };
}
async function advanceRequest(textIn: string, role: Role): Promise<Reply> {
  const t = norm(textIn);
  const who = await whom(t, role); if (!who) return { text: 'Who is the advance for?', tone: 'warn' };
  const amount = findAmount(t)!;
  const self = who.id === session().userId;
  const waiting = self && role !== 'owner';
  // always the check-and-✓ table: an advance moves money, so it is never recorded the moment it is said
  const staff = (await db.staff.toArray()).filter(x => x.active && x.role !== 'owner');
  return {
    text: waiting ? `Advance ${inr(amount)}. Check and tap ✓ to send the request to the owner.` : `Advance ${inr(amount)} to ${who.name.split(' ')[0]}. Check and tap ✓.`,
    proposal: {
      id: newId(), kind: 'advance', title: 'Advance',
      fields: [
        { key: 'staffId', label: 'Who', type: 'select', readonly: self, options: (self ? [who] : staff).map(x => ({ value: x.id, label: x.name })), value: who.id },
        { key: 'reason', label: 'Reason', value: textIn },
      ],
      columns: [{ key: 'amount', label: 'Amount ₹', type: 'number', width: 120 }],
      rows: [{ amount }],
      meta: { status: waiting ? 'waiting' : 'approved' },
    },
  };
}
