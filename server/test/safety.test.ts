// Pre-pilot safety round 1 (11 Nov 2026): every attack the security probe proved must be REFUSED by the server.
// Each block below failed before its fix (regression tests written first).
import { CONSENT } from './fixtures.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { freePort } from './fixtures.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pgServer: EmbeddedPostgres;
let pool: pg.Pool;
type App = Awaited<ReturnType<typeof import('../src/app.js').buildApp>>;
let app: App;
const port = await freePort();

beforeAll(async () => {
  process.env.CRON_KEY = 'cron-safety-key';
  pgServer = new EmbeddedPostgres({ databaseDir: join(tmpdir(), 'hanubix-pg-safety-' + Date.now()), user: 'postgres', password: 'pw', port, persistent: false });
  await pgServer.initialise(); await pgServer.start(); await pgServer.createDatabase('dbrox');
  pool = new pg.Pool({ connectionString: `postgres://postgres:pw@localhost:${port}/dbrox` });
  pool.on('error', () => {});
  const { migrate } = await import('../src/db.js'); await migrate(pool);
  const { buildApp } = await import('../src/app.js'); app = await buildApp(pool);
}, 120000);
afterAll(async () => { await app?.close(); await pool?.end(); await pgServer?.stop(); });

let ipNo = 0;
const freshIp = () => `10.0.${Math.floor(++ipNo / 250)}.${ipNo % 250 + 1}`;
const post = async (url: string, body: unknown, token?: string, ip = '10.9.9.9', a: App = app) => {
  const r = await a.inject({ method: 'POST', url, payload: body as object, headers: { 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  let b; try { b = r.json(); } catch { b = r.body; }
  return { status: r.statusCode, body: b };
};
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
type Ch = { table: string; id: string; updatedAt: string; data: Record<string, unknown> };
const sync = (t: string, changes: Ch[] = [], cursor = 0) => post('/v1/sync', { cursor, changes }, t);
const ch = (table: string, id: string, data: Record<string, unknown>, ms = 0): Ch => ({ table, id, updatedAt: iso(ms), data: { id, ...data } });
const doc = async (tbl: string, id: string) => (await pool.query('SELECT data FROM docs WHERE tbl=$1 AND id=$2', [tbl, id])).rows[0]?.data;
const r2 = (n: number) => Math.round(n * 100) / 100;
const fy = () => { const d = new Date(Date.now() + 330 * 60000); const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${String(y).slice(2)}-${String(y + 1).slice(2)}`; };
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const line = (taxable: number) => { const tax = r2(taxable * 0.18); return { productId: 'p1', name: 'Soap', hsn: '3401', qty: 1, freeQty: 0, rate: taxable, mrp: taxable, gross: taxable, discount: 0, taxable, gst: 18, cgst: r2(tax / 2), sgst: r2(tax - r2(tax / 2)), igst: 0, total: r2(taxable + tax), batches: [{ batchId: 'b1', batch: 'B1', qty: 1, expiry: '2027-12-31' }], schemeNames: [] }; };
const bill = (number: string, taxables: number[], extra: Record<string, unknown> = {}) => {
  const lines = taxables.map(line);
  const taxable = r2(lines.reduce((a, l) => a + l.taxable, 0)), cgst = r2(lines.reduce((a, l) => a + l.cgst, 0)), sgst = r2(lines.reduce((a, l) => a + l.sgst, 0));
  const exact = r2(taxable + cgst + sgst), total = Math.round(exact);
  return { number, companyId: 'c1', shopId: 's1', date: today(), kind: 'B2C', lines, taxable, cgst, sgst, igst: 0, roundOff: r2(total - exact), total, schemeSaving: 0, deliveryStatus: 'pending', ...extra };
};
const billNo = async (token: string) => { const r = await post('/v1/number', { kind: 'bill' }, token); return `${r.body.prefix}/${fy()}/${String(r.body.first).padStart(5, '0')}`; };
const cnNo = async (token: string) => { const r = await post('/v1/number', { kind: 'cn' }, token); expect(r.status).toBe(200); return `CN/${fy()}/${String(r.body.first).padStart(5, '0')}`; };

// one distributor with every role
const T = { owner: '', office: '', salesman: '', godown: '', delivery: '', tenant: '', ownerId: '' };
const staffPin: Record<string, string> = { office: '6831', salesman: '2958', godown: '7416', delivery: '5072' };
beforeAll(async () => {
  const s = await post('/v1/signup', { consent: CONSENT, firmName: 'Safe Agencies', ownerName: 'Owner', phone: '9700000001', pin: '482613' });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  T.owner = s.body.token; T.tenant = s.body.tenantId; T.ownerId = s.body.userId;
  const roles = ['office', 'salesman', 'godown', 'delivery'] as const;
  const r = await sync(T.owner, roles.map((role, i) => ch('staff', `st-${role}`, { name: role, phone: `970000001${i}`, role, pin: staffPin[role], active: true })));
  expect(r.body.rejected).toEqual([]);
  for (const [i, role] of roles.entries()) {
    const l = await post('/v1/login', { phone: `970000001${i}`, pin: staffPin[role] }, undefined, freshIp());
    expect(l.status, role).toBe(200); T[role] = l.body.token;
  }
}, 60000);

describe('1. login: tries kept in Postgres, per phone and per IP; common PINs refused; token renewal', () => {
  it('refuses common PINs at signup', async () => {
    for (const pin of ['1234', '0000', '7777', '4321', '1212', '1987', '2026']) {
      const r = await post('/v1/signup', { consent: CONSENT, firmName: 'X', ownerName: 'X', phone: '9700000099', pin }, undefined, freshIp());
      expect(r.status, pin).toBe(400);
    }
  });

  it('a stranger cannot lock the owner out from another place, and the tries survive a server restart', async () => {
    const stranger = freshIp();
    for (let i = 0; i < 5; i++) await post('/v1/login', { phone: '9700000001', pin: '0001' }, undefined, stranger);
    expect((await post('/v1/login', { phone: '9700000001', pin: '482613' }, undefined, stranger)).status).toBe(429);
    // kept in the database: a second server instance (Cloud Run) knows about them too
    const { buildApp } = await import('../src/app.js'); const other = await buildApp(pool);
    expect((await post('/v1/login', { phone: '9700000001', pin: '482613' }, undefined, stranger, other)).status).toBe(429);
    await other.close();
    // the owner, on their own phone's connection, still gets in
    expect((await post('/v1/login', { phone: '9700000001', pin: '482613' }, undefined, freshIp())).status).toBe(200);
  });

  it('one place spraying one PIN over many phones is stopped', async () => {
    const sprayer = freshIp(); const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await post('/v1/login', { phone: String(9600000000 + i), pin: '4826' }, undefined, sprayer)).status);
    expect(codes.filter(c => c === 429).length).toBeGreaterThan(15);
  });

  it('many places guessing one phone: a SHORT lock on that phone (never a long lock-out)', async () => {
    for (let i = 0; i < 10; i++) await post('/v1/login', { phone: '9700000010', pin: '0002' }, undefined, freshIp());
    expect((await post('/v1/login', { phone: '9700000010', pin: staffPin.office }, undefined, freshIp())).status).toBe(429);
    const row = (await pool.query(`SELECT extract(epoch FROM until - now()) s FROM rate_hits WHERE key = 'login:9700000010'`)).rows[0];
    expect(Number(row.s)).toBeLessThanOrEqual(10 * 60);
  });

  it('a staff PIN change to a common PIN is refused; an unchanged old PIN still syncs (existing users unaffected)', async () => {
    // an old login made before this rule, with an easy PIN
    const { hashPin } = await import('../src/auth.js');
    await pool.query(`INSERT INTO users(tenant_id,id,phone,name,role,pin_hash) VALUES ($1,'st-old','9700000020','Old','salesman',$2)`, [T.tenant, hashPin('1111')]);
    const r = await sync(T.owner, [ch('staff', 'st-old', { name: 'Old', phone: '9700000020', role: 'salesman', pin: '1111', active: true })]);
    expect(r.body.rejected).toEqual([]);
    const bad = await sync(T.owner, [ch('staff', 'st-old', { name: 'Old', phone: '9700000020', role: 'salesman', pin: '9999', active: true }, 1000)]);
    expect(bad.body.rejected).toEqual(['staff|st-old']);
    const nw = await sync(T.owner, [ch('staff', 'st-new', { name: 'New', phone: '9700000021', role: 'salesman', pin: '2000', active: true })]);
    expect(nw.body.rejected).toEqual(['staff|st-new']);
  });

  it('a token with 7 days or less left is renewed in the sync reply', async () => {
    const { signToken, readToken } = await import('../src/auth.js');
    const short = signToken({ t: T.tenant, u: T.ownerId, r: 'owner', e: 0 }, 5);
    const r = await sync(short);
    expect(typeof r.body.token).toBe('string');
    // the owner's tokens last 14 days (security standard, 13 Nov 2026: the owner can export everything); staff 30
    expect(readToken(r.body.token)!.exp).toBeGreaterThan(Date.now() / 1000 + 13 * 86400);
    expect(readToken(r.body.token)!.exp).toBeLessThan(Date.now() / 1000 + 15 * 86400);
    expect((await sync(T.owner)).body.token).toBeUndefined(); // a fresh one: nothing to renew
  });
});

describe('2. distributor field rules (staff phones are not trusted with money or approvals)', () => {
  let no1 = '';
  beforeAll(async () => {
    no1 = await billNo(T.owner);
    const r = await sync(T.owner, [
      ch('invoices', 'inv1', bill(no1, [847.46])),
      ch('payments', 'pay1', { shopId: 's1', amount: 500, mode: 'cash', date: today(), collectedBy: T.ownerId, allocations: [], advance: 0, settled: false, status: 'ok' }),
      ch('orders', 'o1', { shopId: 's1', lines: [], status: 'approved', date: today(), issues: [], invoiceIds: [] }),
      ch('audit', 'a1', { action: 'owner cancelled bill', at: iso() }),
      ch('shops', 's1', { name: 'Murugan', creditLimit: 10000 }),
    ]);
    expect(r.body.rejected).toEqual([]);
  });

  it('delivery cannot change a bill total, lines or number; may record the delivery', async () => {
    const inv = await doc('invoices', 'inv1');
    const cheat = await sync(T.delivery, [{ table: 'invoices', id: 'inv1', updatedAt: iso(2000), data: { ...inv, total: 1, paid: true } }]);
    expect(cheat.body.rejected).toEqual(['invoices|inv1']);
    expect((await doc('invoices', 'inv1')).total).toBe(1000);
    // the reply carries the server's copy so the phone corrects itself
    expect(cheat.body.current.find((c: Ch) => c.id === 'inv1')?.data.total).toBe(1000);
    const cancel = await sync(T.delivery, [{ table: 'invoices', id: 'inv1', updatedAt: iso(2100), data: { ...inv, cancelled: { at: iso(), by: 'x', reason: 'x' } } }]);
    expect(cancel.body.rejected).toEqual(['invoices|inv1']);
    const lines = inv.lines.map((l: Record<string, unknown>) => ({ ...l, batches: [] }));
    const ok = await sync(T.delivery, [{ table: 'invoices', id: 'inv1', updatedAt: iso(2200), data: { ...inv, lines, deliveryStatus: 'delivered', delivery: { at: iso(), by: 'st-delivery', shortages: [] } } }]);
    expect(ok.body.rejected).toEqual([]);
    expect((await doc('invoices', 'inv1')).deliveryStatus).toBe('delivered');
    // and cannot make a new bill
    expect((await sync(T.delivery, [ch('invoices', 'inv-d', bill(no1 + 'x', [10]))])).body.rejected).toEqual(['invoices|inv-d']);
  });

  it("a bill's total must equal its lines plus round-off (even from the owner)", async () => {
    const r = await sync(T.owner, [ch('invoices', 'inv-bad', { ...bill(await billNo(T.owner), [100]), total: 5000 })]);
    expect(r.body.rejected).toEqual(['invoices|inv-bad']);
  });

  it("payments: created freely; another person's payment, settled and status are not the salesman's", async () => {
    const p = await doc('payments', 'pay1');
    expect((await sync(T.salesman, [{ table: 'payments', id: 'pay1', updatedAt: iso(3000), data: { ...p, amount: 5 } }])).body.rejected).toEqual(['payments|pay1']);
    expect((await doc('payments', 'pay1')).amount).toBe(500);
    const mine = { shopId: 's1', amount: 200, mode: 'cash', date: today(), collectedBy: 'st-salesman', allocations: [], advance: 0, settled: false, status: 'ok' };
    expect((await sync(T.salesman, [ch('payments', 'pay-s1', { ...mine, settled: true })])).body.rejected).toEqual(['payments|pay-s1']);
    expect((await sync(T.salesman, [ch('payments', 'pay-s2', mine)])).body.rejected).toEqual([]);
    expect((await sync(T.salesman, [ch('payments', 'pay-s2', { ...mine, amount: 250 }, 1000)])).body.rejected).toEqual([]);
    expect((await sync(T.salesman, [ch('payments', 'pay-s2', { ...mine, amount: 250, settled: true }, 2000)])).body.rejected).toEqual(['payments|pay-s2']);
    expect((await sync(T.salesman, [ch('payments', 'pay-s2', { ...mine, amount: 250, status: 'bounced' }, 2000)])).body.rejected).toEqual(['payments|pay-s2']);
    // the owner settles it
    expect((await sync(T.owner, [ch('payments', 'pay-s2', { ...mine, amount: 250, settled: true }, 3000)])).body.rejected).toEqual([]);
  });

  it('orders never go backwards on a staff phone', async () => {
    const o = await doc('orders', 'o1');
    expect((await sync(T.salesman, [{ table: 'orders', id: 'o1', updatedAt: iso(4000), data: { ...o, status: 'new' } }])).body.rejected).toEqual(['orders|o1']);
    expect((await sync(T.godown, [{ table: 'orders', id: 'o1', updatedAt: iso(4000), data: { ...o, status: 'picked' } }])).body.rejected).toEqual([]);
    expect((await doc('orders', 'o1')).status).toBe('picked');
  });

  it('nobody approves their own leave, advance or expense; credit limit is the owner\'s', async () => {
    expect((await sync(T.salesman, [ch('leaves', 'l1', { staffId: 'st-salesman', from: today(), to: today(), reason: 'x', status: 'approved' })])).body.rejected).toEqual(['leaves|l1']);
    expect((await sync(T.salesman, [ch('leaves', 'l2', { staffId: 'st-salesman', from: today(), to: today(), reason: 'x', status: 'waiting' })])).body.rejected).toEqual([]);
    expect((await sync(T.salesman, [ch('leaves', 'l2', { staffId: 'st-salesman', from: today(), to: today(), reason: 'x', status: 'approved' }, 1000)])).body.rejected).toEqual(['leaves|l2']);
    expect((await sync(T.salesman, [ch('advances', 'ad1', { staffId: 'st-salesman', amount: 5000, reason: 'x', status: 'approved' })])).body.rejected).toEqual(['advances|ad1']);
    expect((await sync(T.delivery, [ch('expenses', 'e1', { by: 'st-delivery', date: today(), category: 'Diesel', amount: 900, approved: true })])).body.rejected).toEqual(['expenses|e1']);
    expect((await sync(T.delivery, [ch('expenses', 'e2', { by: 'st-delivery', date: today(), category: 'Diesel', amount: 900 })])).body.rejected).toEqual([]);
    const s1 = await doc('shops', 's1');
    expect((await sync(T.salesman, [{ table: 'shops', id: 's1', updatedAt: iso(5000), data: { ...s1, creditLimit: 99999, beat: 'Tue' } }])).body.rejected).toEqual([]);
    expect(await doc('shops', 's1')).toMatchObject({ creditLimit: 10000, beat: 'Tue' });
    await sync(T.salesman, [ch('shops', 's-new', { name: 'New shop', creditLimit: 50000 })]);
    expect((await doc('shops', 's-new')).creditLimit).toBe(0); // new shops start cash-only (owner decision 1)
  });

  it('the history log is add-only for everyone', async () => {
    expect((await sync(T.salesman, [ch('audit', 'a1', { action: 'nothing happened', at: iso() }, 6000)])).body.rejected).toEqual(['audit|a1']);
    expect((await sync(T.owner, [ch('audit', 'a1', { action: 'rewritten', at: iso() }, 6000)])).body.rejected).toEqual(['audit|a1']);
    expect((await doc('audit', 'a1')).action).toBe('owner cancelled bill');
    expect((await sync(T.salesman, [ch('audit', 'a2', { action: 'new entry', at: iso() })])).body.rejected).toEqual([]);
  });
});

describe('3. owner-only fields', () => {
  it("a godown or office save keeps the owner's purchase rate; office never sees it; staff see the UPI id", async () => {
    await sync(T.owner, [ch('products', 'p1', { name: 'Soap', rate: 30, purchaseRate: 25, companyId: 'own' })]);
    const gp = (await sync(T.godown)).body.changes.find((c: Ch) => c.id === 'p1').data;
    expect(gp.purchaseRate).toBeUndefined();
    await sync(T.godown, [{ table: 'products', id: 'p1', updatedAt: iso(1000), data: { ...gp, rack: 'R2' } }]);
    expect(await doc('products', 'p1')).toMatchObject({ purchaseRate: 25, rack: 'R2' });
    const op = (await sync(T.office)).body.changes.find((c: Ch) => c.id === 'p1').data;
    expect(op.purchaseRate).toBeUndefined(); // owner decision 2: buying rates are the owner's only
    await sync(T.office, [{ table: 'products', id: 'p1', updatedAt: iso(2000), data: { ...op, purchaseRate: 1, rate: 31 } }]);
    expect(await doc('products', 'p1')).toMatchObject({ purchaseRate: 25, rate: 31 });
    const settings = (await pool.query(`SELECT id, data FROM docs WHERE tbl='settings' AND tenant_id=$1`, [T.tenant])).rows[0];
    await sync(T.owner, [{ table: 'settings', id: settings.id, updatedAt: iso(1000), data: { ...settings.data, upiId: 'safe@upi' } }]);
    expect((await sync(T.salesman)).body.changes.find((c: Ch) => c.table === 'settings').data.upiId).toBe('safe@upi');
  });
});

describe('4. time, refused records, grace lock', () => {
  it('a phone clock more than 5 minutes ahead is refused (it would freeze the record)', async () => {
    const r = await sync(T.salesman, [{ table: 'orders', id: 'o-fut', updatedAt: '2099-01-01T00:00:00Z', data: { total: 99, status: 'new', lines: [] } }]);
    expect(r.body.rejected).toEqual(['orders|o-fut']);
    expect((await sync(T.salesman, [ch('orders', 'o-ok', { status: 'new', salesmanId: 'st-salesman', lines: [] }, 4 * 60000)])).body.rejected).toEqual([]);
  });

  it('an older copy is ignored and the reply carries the newer server copy', async () => {
    await sync(T.owner, [ch('shops', 's-old', { name: 'Newest' }, 1000)]);
    const r = await sync(T.owner, [ch('shops', 's-old', { name: 'Stale' }, -60000)]);
    expect(r.body.accepted).toEqual(['shops|s-old']);
    expect(r.body.current.find((c: Ch) => c.id === 's-old')?.data.name).toBe('Newest');
  });

  it('a locked plan still takes bills and orders dated before the lock day (made offline in grace)', async () => {
    const s = await post('/v1/signup', { consent: CONSENT, firmName: 'Lapsed', ownerName: 'O', phone: '9700000050', pin: '482613' }, undefined, freshIp());
    const no = await billNo(s.body.token);
    await pool.query(`UPDATE tenants SET trial_ends = current_date - 30 WHERE id=$1`, [s.body.tenantId]);
    const lockOn = (await pool.query(`SELECT (current_date - 30 + 8)::text d`)).rows[0].d as string;
    const before = new Date(Date.parse(lockOn) - 86400000).toISOString().slice(0, 10);
    const r = await sync(s.body.token, [
      ch('orders', 'go1', { status: 'new', lines: [], date: before }),
      ch('invoices', 'gi1', bill(no, [100], { date: before })),
      ch('orders', 'go2', { status: 'new', lines: [], date: today() }),
    ]);
    expect(r.body.rejected).toEqual(['orders|go2']);
  });
});

describe('5. bill and credit-note numbers', () => {
  it('refuses a duplicate number and a number the server never issued', async () => {
    const no = await billNo(T.owner);
    expect((await sync(T.owner, [ch('invoices', 'n1', bill(no, [100]))])).body.rejected).toEqual([]);
    expect((await sync(T.owner, [ch('invoices', 'n2', bill(no, [100]))])).body.rejected).toEqual(['invoices|n2']);
    expect((await sync(T.owner, [ch('invoices', 'n3', bill(`DBX/${fy()}/09999`, [100]))])).body.rejected).toEqual(['invoices|n3']);
    expect((await sync(T.owner, [ch('invoices', 'n4', bill('DBX1', [100]))])).body.rejected).toEqual(['invoices|n4']);
    // the same bill saved again (an edit) keeps its own number
    expect((await sync(T.owner, [ch('invoices', 'n1', bill(no, [100], { printedAt: iso() }), 1000)])).body.rejected).toEqual([]);
  });

  it('every role that can make a credit note gets its number from the server; duplicates refused', async () => {
    for (const role of ['salesman', 'delivery', 'godown', 'office', 'owner'] as const) expect((await post('/v1/number', { kind: 'cn' }, T[role])).status, role).toBe(200);
    expect((await post('/v1/number', { kind: 'bill' }, T.salesman)).status).toBe(403);
    const no = await cnNo(T.owner);
    const cn = { invoiceId: 'inv1', shopId: 's1', companyId: 'c1', date: today(), reason: 'Return', lines: [], total: 10 };
    expect((await sync(T.owner, [ch('creditNotes', 'cn1', { ...cn, number: no })])).body.rejected).toEqual([]);
    expect((await sync(T.owner, [ch('creditNotes', 'cn2', { ...cn, number: no })])).body.rejected).toEqual(['creditNotes|cn2']);
    expect((await sync(T.owner, [ch('creditNotes', 'cn3', { ...cn, number: `CN/${fy()}/PENDING-AB12` })])).body.rejected).toEqual(['creditNotes|cn3']);
  });
});

describe('6. staff phone / PIN change, removal', () => {
  it('a phone change moves the login (old phone and old tokens stop) and never blocks the owner\'s sync', async () => {
    const l = await post('/v1/login', { phone: '9700000012', pin: staffPin.godown }, undefined, freshIp());
    expect(l.status).toBe(200);
    const r = await sync(T.owner, [
      ch('staff', 'st-godown', { name: 'godown', phone: '9700000099', role: 'godown', pin: '3804', active: true }, 1000),
      ch('shops', 'with-phone-change', { name: 'Same batch' }),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rejected).toEqual([]);
    expect((await post('/v1/login', { phone: '9700000012', pin: staffPin.godown }, undefined, freshIp())).status).toBe(401);
    expect((await post('/v1/login', { phone: '9700000099', pin: '3804' }, undefined, freshIp())).status).toBe(200);
    expect((await sync(l.body.token)).status).toBe(401); // logged out (not "removed": its unsent work is kept)
    // a phone already used by someone else in the firm: only that record is refused
    const clash = await sync(T.owner, [ch('staff', 'st-godown', { name: 'godown', phone: '9700000011', role: 'godown', active: true }, 2000), ch('shops', 'after-clash', { name: 'x' })]);
    expect(clash.status).toBe(200);
    expect(clash.body.rejected).toEqual(['staff|st-godown']);
    expect(clash.body.accepted).toContain('shops|after-clash');
  });

  it('the owner changing their own PIN gets a fresh token back (their phone stays signed in)', async () => {
    const r = await sync(T.owner, [ch('staff', T.ownerId, { name: 'Owner', phone: '9700000001', role: 'owner', pin: '592718', active: true }, 1000)]);
    expect(typeof r.body.token).toBe('string');
    expect((await sync(r.body.token)).status).toBe(200);
    T.owner = r.body.token;
  });

  it('a removed staff member is told "Access removed" (the phone wipes itself)', async () => {
    const l = await post('/v1/login', { phone: '9700000013', pin: staffPin.delivery }, undefined, freshIp());
    await sync(T.owner, [ch('staff', 'st-delivery', { name: 'delivery', phone: '9700000013', role: 'delivery', active: false }, 3000)]);
    const r = await sync(l.body.token);
    expect(r.status).toBe(403); expect(r.body.error).toBe('Access removed');
  });
});

describe('7. bad text never blocks a sync', () => {
  it('lone surrogates and \\u0000 are cleaned, the rest of the batch is saved', async () => {
    const raw = `{"cursor":0,"changes":[{"table":"visits","id":"v-bad","updatedAt":"${iso()}","data":{"note":"cut emoji \\ud83d and nul \\u0000 here"}},{"table":"visits","id":"v-good","updatedAt":"${iso()}","data":{"note":"fine"}}]}`;
    const r = await app.inject({ method: 'POST', url: '/v1/sync', payload: raw, headers: { 'content-type': 'application/json', authorization: `Bearer ${T.salesman}` } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().accepted).toEqual(['visits|v-bad', 'visits|v-good']);
    expect((await doc('visits', 'v-bad')).note).toBe('cut emoji � and nul  here');
  });

  it('TESRAX day counts are per phone: staffId|day|deviceId (prefix checked)', async () => {
    const day = today();
    const r = await sync(T.salesman, [
      ch('tesraxDays', `st-salesman|${day}|dev-a`, { day, staffId: 'st-salesman', n: 3 }),
      ch('tesraxDays', `st-salesman|${day}|dev-b`, { day, staffId: 'st-salesman', n: 2 }),
      ch('tesraxDays', `st-office|${day}|dev-a`, { day, staffId: 'st-salesman', n: 9 }),
      ch('tesraxDays', `st-salesman|${day}`, { day, staffId: 'st-salesman', n: 9 }),
    ]);
    expect(r.body.rejected).toEqual([`tesraxDays|st-office|${day}|dev-a`, `tesraxDays|st-salesman|${day}`]);
  });
});

describe('8. size', () => {
  it('a record over 256 KB is refused alone; the pull is cut by size as well as rows', async () => {
    const big = 'x'.repeat(300 * 1024);
    const r = await sync(T.salesman, [ch('visits', 'v-big', { note: big }), ch('visits', 'v-small', { note: 'ok' })]);
    expect(r.body.rejected).toEqual(['visits|v-big']);
    expect(r.body.accepted).toEqual(['visits|v-small']);
    const s = await post('/v1/signup', { consent: CONSENT, firmName: 'Photos', ownerName: 'O', phone: '9700000060', pin: '482613' }, undefined, freshIp());
    const photo = 'data:image/jpeg;base64,' + Buffer.from(Array.from({ length: 180 * 1024 }, (_, i) => (i * 7919) % 251)).toString('base64');
    for (let k = 0; k < 4; k++) await sync(s.body.token, Array.from({ length: 10 }, (_, i) => ch('shops', `ph-${k}-${i}`, { name: 'p', photo })));
    const pull = await sync(s.body.token);
    expect(pull.body.more).toBe(true);
    expect(pull.body.changes.length).toBeLessThan(40);
    expect(JSON.stringify(pull.body).length).toBeLessThan(12 * 1024 * 1024);
  }, 60000);
});

describe('9. relay queue and AI scans', () => {
  it('relay rows are claimed, kept until relayed, and kept in a failed table after 5 failures', async () => {
    const { claimRelay, relayDone, relayFailed } = await import('../src/link.js');
    await pool.query(`INSERT INTO relay_queue(tenant_id, kind, tbl, doc_id) VALUES ('tq','distributor','shops','a'),('tq','distributor','shops','b')`);
    const got = await claimRelay(pool, 10);
    expect(got.length).toBe(2);
    expect((await claimRelay(pool, 10)).length).toBe(0); // another worker does not take the same rows
    expect(Number((await pool.query(`SELECT count(*) n FROM relay_queue WHERE tenant_id='tq'`)).rows[0].n)).toBe(2); // not deleted before relaying
    await relayDone(pool, [got[0]]);
    await relayFailed(pool, [got[1]], 'test'); // failed once: back in the queue for another try
    for (let i = 0; i < 4; i++) { const again = await claimRelay(pool, 10); if (again.length) await relayFailed(pool, again, 'test'); }
    expect(Number((await pool.query(`SELECT count(*) n FROM relay_queue WHERE tenant_id='tq'`)).rows[0].n)).toBe(0);
    expect((await pool.query(`SELECT doc_id FROM relay_failed WHERE tenant_id='tq'`)).rows.map(r => r.doc_id)).toEqual(['b']);
  });

  it('AI scans: owner, office and godown only; a small trial allowance; a daily cap for all', async () => {
    expect((await post('/v1/scan', { kind: 'order', file: 'data:image/png;base64,AAAA' }, T.salesman)).status).toBe(403);
    const month = new Date().toISOString().slice(0, 7);
    await pool.query(`INSERT INTO scan_usage(tenant_id, month, count) VALUES ($1,$2,100) ON CONFLICT (tenant_id, month) DO UPDATE SET count=100`, [T.tenant, month]);
    expect((await post('/v1/scan', { kind: 'order', file: 'data:image/png;base64,AAAA' }, T.owner)).status).toBe(402);
    await pool.query(`UPDATE scan_usage SET count=0 WHERE tenant_id=$1`, [T.tenant]);
    process.env.SCAN_DAILY_CAP = '3';
    await pool.query(`INSERT INTO scan_daily(day, count) VALUES (current_date, 3) ON CONFLICT (day) DO UPDATE SET count=3`);
    expect((await post('/v1/scan', { kind: 'order', file: 'data:image/png;base64,AAAA' }, T.owner)).status).toBe(429);
    delete process.env.SCAN_DAILY_CAP;
  });

  it('sign-ups are limited per place', async () => {
    const ip = freshIp(); const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post('/v1/signup', { consent: CONSENT, firmName: 'F', ownerName: 'O', phone: `95000000${10 + i}`, pin: '482613' }, undefined, ip)).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('cron calls need the key', async () => {
    expect((await post('/v1/cron/relay', {})).status).toBe(403);
    const r = await app.inject({ method: 'POST', url: '/v1/cron/relay', payload: {}, headers: { 'x-cron-key': 'cron-safety-key' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('3b. a company head office keeps its own price to distributors', () => {
  it('cadmin saves and reads purchaseRate (PTD); a rep never sees it', async () => {
    const co = await post('/v1/signup', { consent: CONSENT, firmName: 'Brand', ownerName: 'HO', phone: '9700000070', pin: '482613', kind: 'company' }, undefined, freshIp());
    await sync(co.body.token, [ch('products', 'P1', { name: 'Oil', rate: 100, purchaseRate: 90 }), ch('staff', 'rep1', { name: 'Rep', phone: '9700000071', role: 'rep', pin: '6153', active: true })]);
    expect((await doc('products', 'P1')).purchaseRate).toBe(90);
    expect((await sync(co.body.token)).body.changes.find((c: Ch) => c.id === 'P1').data.purchaseRate).toBe(90);
    const rep = await post('/v1/login', { phone: '9700000071', pin: '6153' }, undefined, freshIp());
    expect((await sync(rep.body.token)).body.changes.find((c: Ch) => c.id === 'P1').data.purchaseRate).toBeUndefined();
  });
});

describe('4b. refusals that are not about the rules keep the phone\'s copy (held, never replaced)', () => {
  it('a too-big or clock-ahead edit of an existing record gets no server copy back (the phone keeps its work)', async () => {
    await sync(T.salesman, [ch('visits', 'v-keep', { note: 'first' })]);
    const big = await sync(T.salesman, [ch('visits', 'v-keep', { note: 'x'.repeat(300 * 1024) }, 1000)]);
    expect(big.body.rejected).toEqual(['visits|v-keep']);
    expect(big.body.current.find((c: Ch) => c.id === 'v-keep')).toBeUndefined();
    const ahead = await sync(T.salesman, [ch('visits', 'v-keep', { note: 'clock ahead' }, 20 * 60000)]);
    expect(ahead.body.rejected).toEqual(['visits|v-keep']);
    expect(ahead.body.current.find((c: Ch) => c.id === 'v-keep')).toBeUndefined();
  });
});

// Part 2 batch 1 security review (14 Nov 2026): a crafted push from a staff phone must not change rates, discounts,
// approvals, another person's orders or the order history. Each case failed before its fix (written first).
describe('10. orders from staff phones (Part 2 batch 1)', () => {
  const G = { t: '' }; // the godown's phone and PIN changed in block 6: log in again
  const o = (x: Record<string, unknown> = {}) => ({ shopId: 's1', salesmanId: 'st-salesman', source: 'salesman', lines: [{ productId: 'pr1', qty: 2, rate: 50, line: 1 }], status: 'new', issues: [], date: today(), invoiceIds: [], ...x });
  beforeAll(async () => {
    expect((await sync(T.owner, [ch('products', 'pr1', { name: 'Tea', rate: 50, gst: 5 }), ch('products', 'pr2', { name: 'Coffee', rate: 80, gst: 5 }),
      ch('orders', 'oa', o({ status: 'approved', approvedBy: T.ownerId, approvedAt: iso(), activity: [{ at: iso(), by: T.ownerId, what: 'approved, sent to godown' }] })),
      ch('orders', 'oother', o({ salesmanId: 'someone-else' })),
    ])).body.rejected).toEqual([]);
    G.t = (await post('/v1/login', { phone: '9700000099', pin: '3804' }, undefined, freshIp())).body.token;
  });
  it('a salesman books in his own name, as new, at the product rate (lower only with his reason), no Disc %', async () => {
    expect((await sync(T.salesman, [ch('orders', 'on1', o())])).body.rejected).toEqual([]);
    const cases: [string, Record<string, unknown>, string][] = [
      ['on2', o({ salesmanId: 'someone-else' }), 'an order is booked in your own name'],
      ['on3', o({ status: 'approved' }), 'a new order waits for the owner'],
      ['on4', o({ approvedBy: 'st-salesman' }), "order field approvedBy is the owner's"],
      ['on5', o({ lines: [{ productId: 'pr1', qty: 2, rate: 40 }] }), "order rate must be the product's rate"],
      ['on6', o({ lines: [{ productId: 'pr1', qty: 2, rate: 60 }], rateRemark: 'x' }), "order rate must be the product's rate"],
      ['on7', o({ lines: [{ productId: 'pr1', qty: 2, rate: 50, discountPct: 5 }] }), "Disc % is the owner's"],
      ['on8', o({ source: 'company' }), 'a company order comes only through the company link'],
    ];
    for (const [id, d, why] of cases) {
      const r = await sync(T.salesman, [ch('orders', id, d)]);
      expect(r.body.rejected, id).toEqual([`orders|${id}`]);
      expect(r.body.reasons?.[`orders|${id}`], id).toBe(why);
    }
    expect((await sync(T.salesman, [ch('orders', 'on9', o({ lines: [{ productId: 'pr1', qty: 2, rate: 45 }], rateRemark: 'Tea @45 — big shop' }))])).body.rejected).toEqual([]);
  });
  it('a salesman changes or cancels only his own new order; never an approved one or another person\'s', async () => {
    const mine = await doc('orders', 'on1');
    expect((await sync(T.salesman, [{ table: 'orders', id: 'on1', updatedAt: iso(1000), data: { ...mine, lines: [{ productId: 'pr1', qty: 5, rate: 50, line: 1 }] } }])).body.rejected).toEqual([]);
    const other = await doc('orders', 'oother');
    const r = await sync(T.salesman, [{ table: 'orders', id: 'oother', updatedAt: iso(1000), data: { ...other, status: 'cancelled' } }]);
    expect(r.body.reasons?.['orders|oother']).toBe('a salesman changes only his own orders');
    const a = await doc('orders', 'oa');
    for (const d of [{ ...a, lines: [{ productId: 'pr1', qty: 9, rate: 50, line: 1 }] }, { ...a, status: 'cancelled' }, { ...a, approvedBy: 'st-salesman' }])
      expect((await sync(T.salesman, [{ table: 'orders', id: 'oa', updatedAt: iso(1100), data: d }])).body.rejected).toEqual(['orders|oa']);
    expect((await sync(T.salesman, [{ table: 'orders', id: 'on1', updatedAt: iso(1200), data: { ...(await doc('orders', 'on1')), status: 'cancelled', issues: ['Cancelled by salesman'] } }])).body.rejected).toEqual([]);
  });
  it('the godown packs an approved order and nothing more; nobody else approves or bills', async () => {
    const a = await doc('orders', 'oa');
    const pick = { ...a, status: 'picked', picked: [{ productId: 'pr1', qty: 2, line: 1 }], pickedBy: 'st-godown', pickedAt: iso() };
    expect((await sync(G.t, [{ table: 'orders', id: 'oa', updatedAt: iso(1300), data: { ...pick, status: 'billed' } }])).body.rejected).toEqual(['orders|oa']);
    expect((await sync(G.t, [{ table: 'orders', id: 'oa', updatedAt: iso(1300), data: { ...pick, lines: [{ productId: 'pr1', qty: 2, rate: 1, line: 1 }] } }])).body.rejected).toEqual(['orders|oa']);
    expect((await sync(G.t, [{ table: 'orders', id: 'oa', updatedAt: iso(1300), data: { ...pick, pickedBy: 'st-salesman' } }])).body.rejected).toEqual(['orders|oa']);
    expect((await sync(G.t, [{ table: 'orders', id: 'on9', updatedAt: iso(1300), data: { ...(await doc('orders', 'on9')), status: 'approved' } }])).body.rejected).toEqual(['orders|on9']);
    expect((await sync(G.t, [{ table: 'orders', id: 'oa', updatedAt: iso(1400), data: pick }])).body.rejected).toEqual([]);
    expect((await doc('orders', 'oa')).status).toBe('picked');
  });
  it('order history only grows, and new entries carry the signed-in person', async () => {
    const a = await doc('orders', 'oa');
    expect((await sync(G.t, [{ table: 'orders', id: 'oa', updatedAt: iso(1500), data: { ...a, activity: [] } }])).body.reasons?.['orders|oa']).toBe('order history only grows');
    expect((await sync(G.t, [{ table: 'orders', id: 'oa', updatedAt: iso(1500), data: { ...a, activity: [{ ...a.activity[0], what: 'rewritten' }] } }])).body.rejected).toEqual(['orders|oa']);
    expect((await sync(G.t, [{ table: 'orders', id: 'oa', updatedAt: iso(1600), data: { ...a, activity: [...a.activity, { at: iso(), by: T.ownerId, what: 'owner said ok' }] } }])).body.rejected).toEqual([]);
    expect((await doc('orders', 'oa')).activity[1].by).toBe('st-godown');
  });
  it('lines the books never take, through the sync, with the reason back to the phone', async () => {
    const bad: [string, Record<string, unknown>, string][] = [
      ['ob1', o({ lines: [{ productId: 'pr1', qty: 1, rate: 50, discountPct: 101 }] }), 'Disc % must be 0 to 100'],
      ['ob2', o({ lines: [{ productId: 'pr1', qty: 1, rate: 50, discountPct: -1 }] }), 'Disc % must be 0 to 100'],
      ['ob3', o({ source: 'company', lines: [{ productId: 'pr1', qty: 1, rate: 50 }, { productId: 'pr1', qty: 2, rate: 50 }] }), 'a company order has each product once'],
      ['ob4', o({ lines: [{ productId: 'pr1', qty: 1, rate: 50, line: 1 }, { productId: 'pr2', qty: 1, rate: 80, line: 1 }] }), 'two order lines have the same line number'],
    ];
    for (const [id, d, why] of bad) {
      const r = await sync(T.owner, [ch('orders', id, d)]);
      expect(r.body.rejected, id).toEqual([`orders|${id}`]);
      expect(r.body.reasons?.[`orders|${id}`], id).toBe(why);
    }
    expect((await sync(T.owner, [ch('orders', 'ob5', o({ lines: [{ productId: 'pr1', qty: 1, rate: 50, discountPct: 100 }] }))])).body.rejected).toEqual([]);
    // a bill line without pieces still never carries a bad Disc %
    const inv = bill(await billNo(T.owner), [100]);
    const noQty = { ...inv, lines: inv.lines.map(l => { const { qty: _q, ...rest } = l; void _q; return { ...rest, discountPct: 500 }; }) };
    const r = await sync(T.owner, [ch('invoices', 'inv-noqty', noQty)]);
    expect(r.body.rejected).toEqual(['invoices|inv-noqty']);
    expect(r.body.reasons?.['invoices|inv-noqty']).toBe('Disc % must be 0 to 100');
  });
  it('a company rep pushes only his own orders, at the product rate', async () => {
    const co = await post('/v1/signup', { consent: CONSENT, firmName: 'Brand Two', ownerName: 'HO', phone: '9700000080', pin: '482613', kind: 'company' }, undefined, freshIp());
    expect((await sync(co.body.token, [ch('products', 'cP1', { name: 'Oil', rate: 100 }), ch('staff', 'crep1', { name: 'Rep A', phone: '9700000081', role: 'rep', pin: '6153', active: true }),
      ch('orders', 'co-other', { shopId: 'x', repId: 'crep2', source: 'company', lines: [{ productId: 'cP1', qty: 1, rate: 100 }], status: 'new', issues: [], date: today(), invoiceIds: [] })])).body.rejected).toEqual([]);
    const rep = (await post('/v1/login', { phone: '9700000081', pin: '6153' }, undefined, freshIp())).body.token;
    const ord = (x: Record<string, unknown>) => ({ shopId: 'x', repId: 'crep1', source: 'company', lines: [{ productId: 'cP1', qty: 1, rate: 100 }], status: 'new', issues: [], date: today(), invoiceIds: [], ...x });
    expect((await sync(rep, [ch('orders', 'co-1', ord({}))])).body.rejected).toEqual([]);
    expect((await sync(rep, [ch('orders', 'co-2', ord({ repId: 'crep2' }))])).body.rejected).toEqual(['orders|co-2']);
    expect((await sync(rep, [ch('orders', 'co-other', ord({ repId: 'crep1' }), 1000)])).body.rejected).toEqual(['orders|co-other']);
    expect((await sync(rep, [ch('orders', 'co-3', ord({ lines: [{ productId: 'cP1', qty: 1, rate: 10 }] }))])).body.rejected).toEqual(['orders|co-3']);
  });
  it('van numbers are unique among vans in use (server too); a stock movement is capped', async () => {
    expect((await sync(T.owner, [ch('vans', 'van-a', { name: 'Van 1', number: 'TN 31 AB 1234', kind: 'own' })])).body.rejected).toEqual([]);
    const r = await sync(T.owner, [ch('vans', 'van-b', { name: 'Van 2', number: 'tn31ab-1234', kind: 'own' })]);
    expect(r.body.rejected).toEqual(['vans|van-b']);
    expect(r.body.reasons?.['vans|van-b']).toBe('this van number is already used by another van');
    expect((await sync(T.owner, [ch('vans', 'van-c', { name: 'Old van', number: 'TN31AB1234', kind: 'own', active: false })])).body.rejected).toEqual([]);
    expect((await sync(T.owner, [ch('stockMoves', 'mv-huge', { batchId: 'b1', productId: 'p1', delta: 2_000_000, at: iso() })])).body.rejected).toEqual(['stockMoves|mv-huge']);
  });
});
