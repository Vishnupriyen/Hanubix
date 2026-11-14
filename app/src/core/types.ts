// Hanubix core data types.
// Scale rule: every record carries tenantId (the distributor) and an id created on the device,
// so the server can split data by distributor and phones never wait for a central counter.

export type Role = 'owner' | 'office' | 'salesman' | 'godown' | 'delivery'
  // company side (a brand's own team): head office, RSM/ASM/SO (one role, with a level), and field rep
  | 'cadmin' | 'manager' | 'rep';
export const COMPANY_ROLES: Role[] = ['cadmin', 'manager', 'rep'];
export const isCompanyRole = (r: Role) => COMPANY_ROLES.includes(r);

// The eight locked modules (spec 15.1). Switched from the Hanubix console, never shown to the distributor.
export type ModuleKey = 'sales' | 'bill' | 'inventory' | 'delivery' | 'collection' | 'accountant' | 'gst' | 'payroll';

export const MODULES: { key: ModuleKey; name: string }[] = [
  { key: 'sales', name: 'TESRAX Sales' },
  { key: 'bill', name: 'TESRAX Bill' },
  { key: 'inventory', name: 'TESRAX Inventory' },
  { key: 'delivery', name: 'TESRAX Delivery' },
  { key: 'collection', name: 'TESRAX Collection' },
  { key: 'accountant', name: 'TESRAX Accountant' },
  { key: 'gst', name: 'TESRAX GST' },
  { key: 'payroll', name: 'TESRAX Payroll' },
];

export interface Base {
  id: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  dirty?: 0 | 1; // 1 = changed on this phone, not yet synced
}

export interface Settings extends Base {
  sameProductTwice?: boolean; // the same product on two lines of a sales bill (Part 2 item 34); missing = on (R1: off while old phones remain)
  firmName: string;
  gstin: string;
  address: string;
  stateCode: string; // '33' = Tamil Nadu
  phone: string;
  modules: Record<ModuleKey, boolean>;
  billFormat: 'A4' | 'A5' | 'dotmatrix';
  returnApprovalLimit: number; // returns above this ₹ need owner OK
  discountAlertPct: number;
  serverUrl?: string;
  backupApproverId?: string;
  billPrefix?: string;      // one running bill series for the distributor (locked spec 15.1)
  nextBillNo?: number;
  nextCnNo?: number;        // credit-note counter when there is no server
  checkInBy?: string;       // 'HH:MM' — check-in after this is "late"
  grnPhoto?: boolean;       // second delivery photo (signed bill / GRN); owner can switch off
  upiId?: string;           // shown as QR at collection
  godownLat?: number; godownLng?: number; // check-in distance is measured from here
  kind?: 'distributor' | 'company';        // a brand's head office uses the same app as a "company"
  travel?: { bike: number; car: number; daLocal: number; daOut: number; limits: Record<string, number> }; // company: ₹ per km, daily allowance, expense limits
  nextReceiptNo?: number;   // collection receipt counter when there is no server
  paidLeaves?: number;      // paid leave days a month (salary sheet); 2 when not set
  writeOffLimit?: number;   // godown damage / count write-offs above this ₹ need the owner's OK; 500 when not set
}

export interface Staff extends Base {
  name: string;
  phone: string;
  role: Role;
  pin?: string; // only while a new staff member's first PIN waits to be sent; the phone then keeps a hash only (core/secure.ts)
  active: boolean;
  vanId?: string;
  salary?: number; batta?: number; // per month / per present day
  kind?: 'db' | 'company_rep'; // company rep sees only his company's products
  companyId?: string;
  // company side
  level?: 'RSM' | 'ASM' | 'SO';   // managers only
  managerId?: string;             // reports to
  territoryId?: string;
  dbLinkIds?: string[];           // the distributors this person works
  hq?: string;                    // home town: outside it the day is "outstation"
  grade?: string;                 // travel policy grade
}

export interface Company extends Base {
  name: string;
  code: string; // bill series prefix
  gstin?: string;
  nextBillNo: number;
  link?: { companyTenant: string; linkId: string; since: string; status: 'linked' | 'left' }; // this company uses Hanubix and sees its own brand here
}

export interface Product extends Base {
  companyId: string;
  name: string;
  code?: string;
  hsn: string;
  gst: number;
  mrp: number;
  rate: number; // selling rate per piece, before GST
  purchaseRate: number;
  caseSize: number;
  aliases: string[];
  focus?: boolean;
  active: boolean;
  unit?: string; // GST unit (UQC); missing = PCS (Part 2 item 10)
  companyProductId?: string; // the company's own id for this product (when the company is linked)
}

export interface Shop extends Base {
  name: string;
  owner?: string;
  phone?: string;
  gstin?: string;
  stateCode?: string; // GST state of the shop (from its GSTIN when it has one; else chosen on the shop form; '33' Tamil Nadu)
  address?: string;
  area: string;
  beat: string;
  salesmanId?: string;
  creditLimit: number;
  creditDays: number;
  cashOnly: boolean;
  type: 'retail' | 'wholesale' | 'subdistributor';
  approved: boolean;
  aliases: string[];
  lat?: number;
  lng?: number;
  photo?: string;
  priceMode?: 'company' | 'distributor';
  tradeDiscountPct?: number;
  creditMode?: 'days' | 'limit' | 'bill_to_bill' | 'none';
  diffPref?: 'modified' | 'credit_note'; // how this shop wants delivery differences handled
  active?: boolean; // false = rejected / closed shop; hidden everywhere
  dbLinkId?: string;     // company side: the distributor this outlet belongs to
  requestedBy?: string;  // a company rep asked for this shop
}

export interface Batch extends Base {
  productId: string;
  batch: string;
  expiry: string;
  mrp: number;
  qty: number; // this phone's running total: the server's qty (the sum of the lot's movements) + this phone's unsent movements
  godown: string;
  legacyQty?: boolean; // changed on this phone before stock moved as movements and not yet sent: sent once as a whole lot
}

export interface Scheme extends Base {
  companyId: string;
  productId?: string;
  name: string;
  type: 'pct' | 'free';
  value: number;
  buyQty?: number;
  freeQty?: number;
  from: string;
  to: string;
  source: 'company' | 'own';
  combine: 'add' | 'replace';
  budget?: number; // company schemes: the most the company will pay out on this scheme
}

export interface OrderLine { productId: string; qty: number; rate: number; batchId?: string; mrp?: number; line?: number; discountPct?: number } // discountPct: the owner's Disc % (replaces scheme %); batch/MRP chosen by the picker; line = stable number 1,2,3… (core/lines.ts)

export interface Order extends Base {
  shopId: string;
  offRoute?: boolean;
  visitId?: string;
  salesmanId?: string;
  source: 'salesman' | 'phone' | 'photo' | 'office' | 'in_person' | 'whatsapp' | 'other' | 'company';
  companyId?: string; companyRep?: string; // a company rep's order (arrives through the company link)
  dbLinkId?: string; repId?: string; repName?: string; // company side: the field order and who took it
  rateRemark?: string; // salesman asked for a lower rate; owner approves
  lines: OrderLine[];
  editedAt?: string; editedBy?: string; // last change in Orders received
  activity?: { at: string; by: string; what: string }[]; // Orders received edits and approvals, oldest first (travels with the order)
  original?: OrderLine[]; // the salesman's lines, kept at the first edit in Orders received (Part 2 item 8)
  // pipeline: new → picked (godown) → billed (owner approved) ; cancelled at any point
  // new (owner to approve) → approved (godown to pick) → picked (owner to verify) → billed
  status: 'new' | 'approved' | 'picked' | 'needs_ok' | 'billed' | 'cancelled';
  approvedBy?: string; approvedAt?: string;
  issues: string[];
  date: string;
  invoiceIds: string[];
  picked?: { productId: string; qty: number; batchId?: string; mrp?: number; line?: number }[]; // what the godown actually packed; line = the order line it packs
  pickedBy?: string;
  pickedAt?: string;
  flagsPending?: boolean;      // a company rep's order just arrived: checked (stock, credit) on the distributor's phone
  cancelledBy?: 'distributor'; cancelReason?: string; // company side: the distributor cancelled the rep's order, and why
}

export interface InvoiceLine {
  productId: string;
  name: string;
  hsn: string;
  qty: number;
  freeQty: number;
  rate: number;
  mrp: number;
  gross: number;
  discount: number;   // ₹ — the legal figure on the bill
  discountPct?: number; // the Disc % the ₹ came from (both kept, so a printed bill never changes)
  taxable: number;
  gst: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  batches: { batchId: string; batch: string; qty: number; expiry: string }[];
  schemeNames: string[];
  costRate?: number; // buying rate per piece when billed (P&L cost; a later rate change never rewrites a past month)
}

export interface Invoice extends Base {
  number: string;
  companyId: string;
  shopId: string;
  orderId?: string;
  date: string;
  kind: 'B2B' | 'B2C';
  lines: InvoiceLine[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
  schemeSaving: number;
  vanId?: string;
  tripId?: string;
  stopNo?: number;
  // pending → planned (on a trip) → out (van left) → delivered / partial / returned / undelivered
  deliveryStatus: 'pending' | 'planned' | 'out' | 'delivered' | 'partial' | 'returned' | 'undelivered';
  delivery?: {
    at: string; by: string; photo?: string; lat?: number; lng?: number;
    shortages: { productId: string; qty: number; reason: string; paid?: number; free?: number; line?: number }[]; // qty = pieces; paid/free = how many were charged vs scheme-free; line = bill line index (old: first line of the product)
    excess?: { productId: string; qty: number; line?: number }[];
    shopPhoto?: string; billPhoto?: string; distanceM?: number;
  };
  diffAction?: 'modified' | 'credit_note'; // owner's choice at day close for delivery differences
  original?: { lines: InvoiceLine[]; total: number; at: string }; // kept when a bill is revised
  printedAt?: string;
  cancelled?: { at: string; by: string; reason: string };
  extraOf?: string; // a new bill for extra pieces given at delivery of this bill (a delivered bill is never re-written)
  opening?: boolean; // never saved: a shop's old due shown as an open bill in balances (ledger.openingAsBill)
}

/** one credit-note line: paid pieces credited at the bill line's own taxable + tax per piece; free pieces at ₹0 */
export interface CreditNoteLine {
  productId: string; line?: number; // index of the bill line
  qty: number; freeQty?: number; amount: number; restock: boolean;
  hsn?: string; gst?: number; taxable?: number; cgst?: number; sgst?: number; igst?: number;
}
export interface CreditNote extends Base {
  number: string;
  invoiceId: string;
  invoiceNumber?: string; invoiceDate?: string; // the original bill (Rule 53)
  shopId: string;
  companyId: string;
  date: string;
  reason: string;
  source?: 'delivery' | 'return';
  lines: CreditNoteLine[];
  taxable?: number; cgst?: number; sgst?: number; igst?: number; roundOff?: number;
  total: number;
}

/** a shop's old due from before Hanubix (loaded from the owner's Excel): shown and collected like an open bill, never a
 *  GST bill, never in sales. Bill-wise (the old bill number) or one amount with a date. */
export interface OpeningDue extends Base {
  shopId: string; ref: string; date: string; amount: number; loadId?: string;
}

/** a staff member's return or stock write-off: nothing changes stock or money until the owner (or office) approves it on
 *  their own phone. A return becomes a credit note with a server number; a write-off takes the pieces out of stock. */
/** One change of a lot's stock (+ in, − out). Stock travels between phones and the server as these, never as an
 *  overwritten total: ChangeSet.commit writes one for every change of a lot's qty, in the same save. Add-only. */
export interface StockMove extends Base {
  batchId: string;
  productId?: string;
  delta: number;   // whole pieces, never 0
  reason: string;  // what the save did ('stock out', 'stock in', 'count adjust …')
  src?: string;    // the record that caused it ('invoices:<id>')
  by: string;
  at: string;
}

/** Business Boost: a distributor asked for a service (GST/CA help, working capital, insurance, equipment, data, Tally) */
export interface BoostRequest extends Base { kind: string; note?: string; status: 'open' | 'done' | 'cancelled'; by: string }

export interface StaffRequest extends Base {
  kind: 'return' | 'damage' | 'count';
  by: string; role: string; date: string;
  status: 'waiting' | 'approved' | 'rejected';
  reason: string;
  value: number;          // ₹ shown to the person deciding (returns: the credit; write-offs: pieces at buying or selling rate)
  ownerOnly?: boolean;    // above the owner's limit: the owner decides, not the office
  shopId?: string;
  rows: Record<string, string | number>[]; // return: invoiceId, productId, qty, restock · damage: productId, qty, kind, fromStock, note · count: batchId, productId, system, counted
  photo?: string;
  decidedBy?: string; decidedAt?: string; rejectReason?: string;
  result?: string;        // what approving made (credit note numbers / stock moved)
}

export interface Payment extends Base {
  shopId: string;
  amount: number;
  mode: 'cash' | 'upi' | 'cheque' | 'bank';
  ref?: string;
  date: string;
  collectedBy: string;
  shopConfirmed: boolean;
  confirmPhoto?: string;
  allocations: { invoiceId: string; amount: number }[];
  advance: number; // unallocated amount kept on account
  settled: boolean;
  bankLineId?: string;
  status: 'ok' | 'waiting_shop' | 'bounced' | 'cancelled';
  correctionOf?: string; // this payment replaces a wrong one (kept, cancelled, for the audit trail)
  dupOk?: boolean;       // the owner checked: the same amount twice from this shop today is real, not a double entry
  note?: string;
  receiptNo?: string;    // R/FY/n — the running receipt number the shop is shown (from the server; numbered at next sync when offline)
  chequeBank?: string;   // a cheque: the bank written on it
  chequeDate?: string;   // a cheque: the date written on it (post-dated: it clears no dues before this day)
  bounce?: { at: string; by: string; reason: string };
}

export interface Purchase extends Base {
  companyId: string;
  supplierGstin?: string;
  paid?: number; // paid to the company so far
  billNo: string;
  date: string;
  lines: {
    productId: string; batch: string; expiry: string; mrp: number;
    qty: number; freeQty: number; rate: number; discount: number; gst: number; amount: number;
    batchId?: string; // the lot this line's pieces went into (Part 2: the same product on two lines = two lots, each its own cost)
  }[];
  taxable: number;
  tax: number;
  total: number;
  source: 'photo' | 'excel' | 'typed' | 'company'; // 'company' = received against the linked company's own bill
  credited?: number; // company credit notes set against this bill
  settlements?: { date: string; amount: number; kind: 'payment' | 'credit_note'; ref?: string; mode?: string }[];
  valuePending?: boolean; // saved on a staff phone without the buying rate: valued when the owner's phone next opens
}

export interface Expense extends Base {
  approved?: boolean; // owner approves in bulk at day close
  by?: string;
  date: string;
  category: string;
  amount: number;
  vanId?: string;
  note?: string;
  photo?: string;
  status?: 'waiting' | 'approved' | 'rejected'; // company side: a field rep's expense, approved with the month's claim
  gross?: number; // salary: the full salary (cash paid + advance/shortfall recovered) — the P&L cost
}

export interface BankLine extends Base {
  date: string;
  narration: string;
  credit: number;
  debit: number;
  ref?: string;
  shopId?: string;
  paymentId?: string;
  status: 'matched' | 'unmatched' | 'ignored';
  statement: string;
}

export interface ClaimEntry extends Base {
  companyId: string;
  month: string;
  kind: 'scheme' | 'damage' | 'expiry' | 'transit' | 'shortage' | 'rate_diff' | 'dsr';
  productId?: string;
  qty: number;
  amount: number;
  note?: string;
  photo?: string;
  invoiceId?: string;
  refNumber?: string; irn?: string; // the company bill this line is about (GST: a credit note must point to it)
  dropped?: string;       // why this line is not claimed (bill cancelled, all returned, owner dropped it)
  valuePending?: boolean; // saved on a staff phone without the buying rate: valued when the owner's phone next opens
}

export interface Claim extends Base {
  companyId: string;
  month: string;
  amount: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'received';
  received?: number;
  note?: string;
  lineIds?: string[]; // the claim lines sent (a linked company sees and checks each one)
}

export interface Trip extends Base {
  vanId: string;
  driverId?: string;
  date: string;
  status: 'planned' | 'loaded' | 'out' | 'done';
  stops: string[]; // shopIds in order
  startedAt?: string;
  endedAt?: string;
  track: { at: string; lat: number; lng: number }[];
}

export interface DayClose extends Base {
  date: string;
  closedBy: string;
  summary: Record<string, unknown>;
}

export interface DayPlan extends Base {
  date: string;
  shopIds: string[]; // standalone delivery: today's chosen shops in route order
}

export interface CheckIn extends Base {
  staffId: string; date: string; at: string; lat?: number; lng?: number; distanceM?: number; late: boolean; out?: string;
}
export interface LeaveRequest extends Base {
  staffId: string; from: string; to: string; reason: string; status: 'waiting' | 'approved' | 'rejected';
}
export interface Advance extends Base {
  staffId: string; amount: number; reason: string; status: 'waiting' | 'approved' | 'rejected'; instalments?: number; recovered?: number;
  kind?: 'advance' | 'shortfall'; // shortfall = cash not handed over at day close; shown daily until cleared
  date?: string;
}
export interface LiteEntry extends Base {
  date: string;
  shopId: string;
  kind: 'delivered' | 'closed' | 'refused' | 'payment';
  amount?: number;
  mode?: 'cash' | 'upi' | 'cheque';
  ref?: string;
  photo?: string;
  by: string;
  shopConfirmed?: boolean;
}

export interface Visit extends Base {
  shopId: string;
  staffId: string;
  date: string;
  at: string;
  lat?: number;
  lng?: number;
  farFromShop?: boolean;
  outcome?: 'order' | 'no_order' | 'closed' | 'payment_only';
  reason?: string;   // why no order (company rep)
  photo?: string;    // shelf photo (company rep)
}

export interface Target extends Base {
  companyId: string;
  month: string;
  kind: 'sales' | 'purchase' | 'shops' | 'lines';
  value: number;
  staffId?: string; // company side: a field rep's monthly target
}

export interface Van extends Base {
  name: string;
  number: string;
  kind: 'own' | 'hired' | 'auto';
  driverId?: string;
  capacity?: number; // cases per trip; missing = no limit (Part 2)
  active?: boolean;  // false = hidden (deleted, or kept for old trips/expenses); missing = active
}

export interface AuditEntry extends Base {
  at: string;
  by: string;
  action: string;
  table: string;
  recordId: string;
  before?: unknown;
  after?: unknown;
  batchId: string; // all changes from one approval share this, for undo
  undone?: boolean;
}

// ---------------------------------------------------------------- company module
export interface Territory extends Base { name: string; parentId?: string; level: 'state' | 'region' | 'area' | 'territory' }
export interface DbLink extends Base {
  name: string;               // the distributor's firm name
  town?: string;
  territoryId?: string;
  inviteCode: string;
  status: 'invited' | 'linked' | 'left' | 'paused';
  dbTenantId?: string;
  linkedAt?: string;
  normDays?: number;          // stock norm: days of stock this distributor should hold
  gstin?: string;             // matches the distributor on the company's own invoices
  kind?: 'distributor' | 'super_stockist' | 'sub_stockist';
  parentLinkId?: string;      // a sub-stockist buys from this super stockist
}
export interface SecondaryLine { productId: string; name?: string; qty: number; freeQty: number; rate: number; taxable: number; total?: number } // compact: a big brand receives hundreds of thousands a day
export interface Secondary extends Base { dbLinkId: string; number: string; date: string; shopId: string; orderId?: string; fieldOrderId?: string; lines: SecondaryLine[]; taxable: number; total: number; deliveryStatus?: string; cancelled: boolean }
export interface SecondaryReturn extends Base { dbLinkId: string; invoiceId: string; date: string; reason: string; lines: { productId: string; name: string; qty: number; amount: number }[]; total: number }
export interface DbStock extends Base { dbLinkId: string; productId: string; name: string; qty: number; nearExpiry: number; expired: number; asOf: string }
export interface PrimaryLine { productId: string; name: string; hsn?: string; qty: number; freeQty?: number; rate: number; gst: number; taxable: number; tax: number; batch?: string; expiry?: string; mrp?: number }
export interface PrimaryInvoice extends Base {
  dbLinkId: string; number: string; irn?: string; date: string; lines: PrimaryLine[]; taxable: number; tax: number; total: number;
  primaryOrderId?: string; source: 'typed' | 'excel'; cancelled?: boolean;
}
/** a linked company's bill to this distributor: the COMPANY's record (only the relay writes it) */
export interface Inbound extends Base {
  companyId: string; number: string; irn?: string; date: string; lines: (PrimaryLine & { coProductId: string })[]; taxable: number; tax: number; total: number;
  primaryOrderId?: string; cancelled?: boolean;
}
/** the distributor's own record of receiving a company bill (id = the bill's id); the company only ever reads it */
export interface Receipt extends Base {
  inboundId: string; companyId: string; status: 'received' | 'disputed';
  receivedAt: string; receivedBy: string; purchaseId: string;
  short: { productId: string; qty: number }[]; damaged: { productId: string; qty: number }[]; // company product ids
}
export interface Grn extends Base { dbLinkId: string; primaryInvoiceId: string; number: string; status: string; receivedAt?: string; short: { productId: string; qty: number }[]; damaged: { productId: string; qty: number }[] }
export interface PrimaryOrder extends Base { companyId?: string; dbLinkId?: string; date: string; lines: { productId: string; name?: string; qty: number }[]; status: 'sent' | 'invoiced' | 'cancelled'; note?: string }
export interface DbClaim extends Base {
  dbLinkId: string; month: string; kind?: string; amount: number; status: string; note?: string;
  lines: { id: string; kind: string; productId?: string; qty: number; amount: number; note?: string; invoiceId?: string; refNumber?: string; irn?: string; photo?: string }[];
}
export interface ClaimDecision extends Base {
  dbLinkId?: string; companyId?: string; claimId: string;
  status: 'recommended' | 'approved' | 'rejected'; // an SO recommends; head office approves or rejects (only those reach the distributor)
  amount: number; creditNoteNo?: string; note?: string; decidedBy: string;
  lines?: { lineId: string; amount: number; schemeId?: string }[];
}
export interface TravelClaim extends Base {
  staffId: string; month: string; days: number; km: number; kmAmount: number; daDays: number; outDays: number; daAmount: number; expenses: number; total: number;
  flags: string[]; status: 'waiting' | 'approved' | 'rejected'; decidedBy?: string; note?: string;
}
export interface ShopRequest extends Base { dbLinkId: string; name: string; area?: string; beat?: string; lat?: number; lng?: number; photo?: string; repId: string; repName: string }
export interface WorkDay extends Base {
  staffId: string; date: string; startAt: string; endAt?: string;
  track: { at: string; lat: number; lng: number; acc?: number }[];
  km: number; flags: string[]; outstation: boolean; mode: 'bike' | 'car' | 'bus';
  lastAt?: string; // the latest location reading, even when it was not far enough to be a new point
}

export type TableName =
  | 'settings' | 'staff' | 'companies' | 'products' | 'shops' | 'batches' | 'schemes'
  | 'orders' | 'invoices' | 'creditNotes' | 'payments' | 'purchases' | 'expenses'
  | 'bankLines' | 'claimEntries' | 'claims' | 'vans' | 'audit' | 'visits' | 'targets' | 'trips' | 'dayCloses' | 'dayPlans' | 'liteEntries' | 'checkIns' | 'leaves' | 'advances'
  | 'territories' | 'dbLinks' | 'secondary' | 'secondaryReturns' | 'dbStock' | 'primaryInvoices' | 'inbound' | 'grns' | 'primaryOrders' | 'dbClaims' | 'claimDecisions' | 'shopRequests' | 'workDays' | 'travelClaims' | 'receipts' | 'tesraxDays' | 'openingDues' | 'requests' | 'stockMoves' | 'boostRequests';

/** TESRAX report: one record per staff per day (small to sync; the owner reads every staff's days).
 *  Counts every message to TESRAX: its speed on the real phone, whether it was understood, and what happened to the table it prepared. */
export interface TesraxDay extends Base {
  day: string;           // yyyy-mm-dd
  staffId: string;
  role: string;
  n: number;             // messages
  done: number;          // TESRAX prepared a table to approve
  answer: number;        // answered, or opened a screen
  ask: number;           // asked a question back (a name, a quantity)
  missed: number;        // did not understand
  refused: number;       // a clear no (not this role's work)
  msTotal: number;       // total reply time, on this phone
  msMax: number;
  approved: number;      // tables approved exactly as TESRAX prepared them
  edited: number;        // approved after changing a row
  cancelled: number;
  misses: string[];      // the last few messages it missed, to fix them
}
