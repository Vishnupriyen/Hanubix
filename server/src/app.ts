import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { billingState, isUpgrade, istToday, makeLicence, PACKS, sealLicence, TIERS, type Billing } from './licence.js';
import type pg from 'pg';
import { config, rates } from './config.js';
import { hashPin, pinFits, pinLength, readToken, signToken, verifyPin, type Claims } from './auth.js';
import { logEvent, phoneMark, rotateLog, type SecEvent } from './seclog.js';
import { addConsent, CONSENT_KINDS, consentsOf, DUE_DAYS, eraseSubject, exportPerson, firmConsent, grievance, PRIVACY_VERSION, retention } from './privacy.js';
import { badLines, badMoney, badMove, billAddsUp, billLotsOk, cleanText, creditNoteRoom, distributorRule, orderRates, stampActivity, vanKey, keepCreditLimit, keepDeliveryResult, keepLineNumbers, keepOwnerOnly, mayDownload, numberIssued, OWN_ROWS, weakPin } from './rules.js';
import { clearHits, hit, isLocked, tooMany } from './limits.js';
import { scanWithAI, type ScanKind } from './scan.js';
import { BIG_TABLES, companyDocs, companyReport, scopeFor } from './reports.js';
import { relayIdle } from './link.js';
import { coverIdle } from './reports.js';
import { archiveAll, archiveMonth, archiveMonths, DB_ARCHIVE } from './archive.js';
import { acceptInvite, afterSave, companyRule, drainRelay, findInvite, keepCompanyFields, leaveLink, queueRelay, relayOnly, resyncLink, tenantKind } from './link.js';

// ONE shared table definition for phone and server (shared/tables.json): a table cannot exist on one side only.
import { readFileSync } from 'node:fs';
const sharedPath = [new URL('../../shared/tables.json', import.meta.url), new URL('../shared/tables.json', import.meta.url)].find(u => { try { readFileSync(u); return true; } catch { return false; } })!;
const SHARED = JSON.parse(readFileSync(sharedPath, 'utf8')) as { tables: string[]; read: Record<string, string[] | '*'>; write: Record<string, string[] | '*'>; ownerOnlyFields: Record<string, string[]> };
const ALL_TABLES = SHARED.tables;
const expand = (m: Record<string, string[] | '*'>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === '*' ? ALL_TABLES : v])) as Record<string, string[]>;
const READ = expand(SHARED.read);
const WRITE = expand(SHARED.write);
const OWNER_ONLY = SHARED.ownerOnlyFields;
// Money records are never overwritten by an older copy; newest wins for everything (last-writer-wins on updatedAt).
/** owner-only fields (buying rates) are removed for everyone but the owner (owner decision, 11 Nov 2026: office too).
 *  A company's head office (cadmin) is that tenant's owner: its purchaseRate is its own price to distributors. */
const forRole = (role: string, tbl: string, d: Record<string, unknown>) => {
  if (role === 'owner' || role === 'cadmin' || !OWNER_ONLY[tbl]) return d;
  const out = { ...d }; for (const f of OWNER_ONLY[tbl]) delete out[f]; return out;
};
const DOC_MAX = 256 * 1024;          // one record (a photo inside it included); bigger is refused, that record only
const CLOCK_AHEAD_MS = 5 * 60000;    // a phone clock ahead by more than this would freeze a record: refused
const RENEW_DAYS = 7;                // a token with this many days or less left is renewed in the sync reply
const CODE = (e: unknown) => String((e as { code?: string }).code ?? (e as Error)?.name ?? 'error');

const newId = () => randomBytes(12).toString('base64url');
const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** pool: the limited role (hanubix_app) every request uses. owner: the database owner, for the maintenance jobs that
 *  drop old activity-log months (the limited role cannot drop anything). Tests pass one pool for both. */
export async function buildApp(pool: pg.Pool, opts: { owner?: pg.Pool } = {}) {
  const owner = opts.owner ?? pool;
  const R = rates();
  // trustProxy 1: Caddy (deploy/Caddyfile) adds the caller's address last; only that one hop is trusted (per-place limits).
  // A CDN in front later would need this changed first, or the limits could be fooled by a made-up header.
  const app = Fastify({ logger: process.env.NODE_ENV === 'production', bodyLimit: 12 * 1024 * 1024, trustProxy: (_addr: string, hop: number) => hop < 1 });
  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  // security headers on every answer (Caddy adds HSTS and the rest in front too; these hold even without it)
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/v1/')) reply.header('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
  // requests per minute from one place (an office behind one router shares this); Razorpay's webhook is signed and exempt
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/') || req.url.startsWith('/v1/razorpay/')) return;
    if (tooMany(`place:${req.ip}`, R.perPlace)) return reply.code(429).send({ error: 'Too many requests from this connection. Wait a minute and try again.' });
  });
  /** one activity-log row for this request (its address added) */
  const sec = (req: FastifyRequest, e: SecEvent) => logEvent(pool, { ...e, ip: req.ip });
  /** a login's own limit per minute on a costly route */
  const perUser = (c: Claims, route: string, max: number) => { if (tooMany(`${route}:${c.t}:${c.u}`, max)) throw err(429, 'Too many requests. Wait a minute and try again.'); };
  // keep the raw text of every JSON body: Razorpay's signature is over the exact bytes it sent
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    // text Postgres can't store (lone half of an emoji, \u0000) is cleaned here, so it never blocks a whole sync
    try { done(null, (body as string).length ? cleanText(JSON.parse(body as string)) : {}); } catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
  });

  // ---------------------------------------------------------------- plans & licences
  const billingOf = async (tenantId: string): Promise<Billing & { name: string; pendingPack: string | null; pendingTier: string | null; sub: string | null } | null> => {
    const r = (await pool.query('SELECT name, tier, pack, trial_ends, paid_until, pending_pack, pending_tier, rzp_subscription_id FROM tenants WHERE id=$1', [tenantId])).rows[0];
    if (!r) return null;
    const d = (v: Date | string | null) => v ? (typeof v === 'string' ? v.slice(0, 10) : new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10)) : null;
    return { name: r.name, tier: r.tier, pack: r.pack, trialEnds: d(r.trial_ends), paidUntil: d(r.paid_until), pendingPack: r.pending_pack, pendingTier: r.pending_tier, sub: r.rzp_subscription_id };
  };
  const licenceFor = async (tenantId: string) => { const b = await billingOf(tenantId); return b ? sealLicence(makeLicence(tenantId, b, istToday())) : null; };
  const stateFor = async (tenantId: string) => { const b = await billingOf(tenantId); return b ? { ...billingState(b, istToday()), mods: new Set(PACKS[b.pack] ?? PACKS.complete) } : null; };
  const LOCKED_MSG = 'Hanubix is locked because the plan is not renewed. You can still collect money and download your data. Renew to take orders and make bills again.';

  const auth = async (req: FastifyRequest): Promise<Claims> => {
    const c = readToken(req.headers.authorization);
    if (!c) throw err(401, 'Please log in');
    const u = (await pool.query('SELECT active, token_epoch, role FROM users WHERE tenant_id=$1 AND id=$2', [c.t, c.u])).rows[0];
    if (!u || !u.active) throw err(403, 'Access removed'); // the phone wipes its data
    if (u.token_epoch !== c.e) throw err(401, 'Please log in again'); // PIN or phone changed: log in again, unsent work kept
    // a locked distributor can still log in, see everything, collect and export — only new orders/bills are refused
    return { ...c, r: u.role };
  };

  // security headers on every reply (free scan, 13 Nov 2026): no content sniffing, never inside a frame, HTTPS only for a year
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    reply.header('referrer-policy', 'no-referrer');
  });
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, service: 'dbrox', time: new Date().toISOString() };
  });

  // New distributor: firm + owner. Owner logs in with phone + PIN (Google sign-in can be added later).
  app.post('/v1/signup', { bodyLimit: 16 * 1024 }, async req => {
    const b = req.body as { firmName?: string; ownerName?: string; phone?: string; pin?: string; gstin?: string; address?: string; kind?: string; consent?: { version?: string; optional?: Record<string, boolean> } };
    const kind = b.kind === 'company' ? 'company' : 'distributor';
    const ownerRole = kind === 'company' ? 'cadmin' : 'owner';
    // a free trial costs us (AI scans, storage): a few sign-ups per place per hour
    if (await hit(pool, `signup:${req.ip}`, SIGNUP_PER_HOUR + 1, 60, 60) || await isLocked(pool, [`signup:${req.ip}`])) throw err(429, 'Too many sign-ups from this connection. Try again in an hour.');
    if (!b.firmName || !b.ownerName || !/^[6-9]\d{9}$/.test(b.phone ?? '') || !pinFits(ownerRole, b.pin)) throw err(400, `Firm, owner name, 10-digit mobile and ${pinLength(ownerRole)}-digit PIN needed`);
    if (weakPin(b.pin!)) throw err(400, `This PIN is too easy to guess (like 123456, 111111 or a date). Choose another ${pinLength(ownerRole)}-digit PIN.`);
    // DPDP: nothing is taken before the person has read the privacy notice and ticked the box (never pre-ticked)
    if (b.consent?.version !== PRIVACY_VERSION) throw err(400, 'Please read the privacy notice and tick the box to continue.');
    const exists = await pool.query('SELECT 1 FROM users WHERE phone=$1', [b.phone]);
    if (exists.rowCount) throw err(409, 'This phone number already has a DBRoX login');
    const tenantId = newId();
    const userId = newId();
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO tenants(id, name, status, trial_ends, kind) VALUES ($1,$2,'trial', current_date + 60, $3)`, [tenantId, b.firmName, kind]);
      await client.query('INSERT INTO users(tenant_id,id,phone,name,role,pin_hash,pin_len,last_login) VALUES ($1,$2,$3,$4,$5,$6,$7,now())', [tenantId, userId, b.phone, b.ownerName, ownerRole, hashPin(b.pin!), b.pin!.length]);
      await addConsent(client, tenantId, userId, 'privacy', true, req.ip);
      for (const k of CONSENT_KINDS.slice(1)) if (typeof b.consent.optional?.[k] === 'boolean') await addConsent(client, tenantId, userId, k, b.consent.optional[k], req.ip);
      const settings = {
        id: newId(), tenantId, createdAt: now, updatedAt: now, firmName: b.firmName, gstin: b.gstin ?? '', address: b.address ?? '', stateCode: (b.gstin ?? '33').slice(0, 2), phone: b.phone,
        modules: { sales: true, bill: true, inventory: true, delivery: true, collection: true, accountant: true, gst: true, payroll: true },
        billFormat: 'A5', returnApprovalLimit: 2000, discountAlertPct: 5, kind,
      };
      const staff = { id: userId, tenantId, createdAt: now, updatedAt: now, name: b.ownerName, phone: b.phone, role: ownerRole, pin: '', active: true };
      await client.query('INSERT INTO docs(tenant_id,tbl,id,data,updated_at) VALUES ($1,$2,$3,$4,$5),($1,$6,$7,$8,$5)', [tenantId, 'settings', settings.id, settings, now, 'staff', userId, staff]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await sec(req, { tenant: tenantId, actor: userId, role: ownerRole, event: 'signup', detail: { kind } });
    return { tenantId, userId, token: signToken({ t: tenantId, u: userId, r: ownerRole, e: 0 }), licence: await licenceFor(tenantId) };
  });

  app.post('/v1/login', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const b = req.body as { phone?: string; pin?: string };
    if (!b.phone || !b.pin) throw err(400, 'Phone and PIN needed');
    // wrong tries are counted in the database: per phone from one place (5 → 15 min), per phone from anywhere (10 → a
    // short 10 min, so nobody can lock someone else out for long), per place over all phones (20 → 30 min)
    const pair = `login:${b.phone}|${req.ip}`, onePhone = `login:${b.phone}`, place = `loginip:${req.ip}`;
    if (await isLocked(pool, [pair, onePhone, place])) { await sec(req, { event: 'login.locked', target: phoneMark(b.phone), ok: false }); throw err(429, 'Too many wrong PINs. Try again in a few minutes.'); }
    const bt = (req.body as { tenantId?: string }).tenantId;
    const all = (await pool.query('SELECT u.tenant_id, u.id, u.role, u.pin_hash, u.pin_len, u.active, u.token_epoch, t.name AS firm FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.phone=$1 AND u.active', [b.phone])).rows;
    const ok = all.filter(u => verifyPin(b.pin!, u.pin_hash) && (!bt || u.tenant_id === bt));
    if (!ok.length) {
      const locked = [await hit(pool, pair, 5, 15, 15), await hit(pool, onePhone, 10, 15, 10), await hit(pool, place, 20, 60, 30)].some(Boolean);
      await sec(req, { tenant: all.length === 1 ? all[0].tenant_id : null, actor: all.length === 1 ? all[0].id : null, event: 'login.fail', target: phoneMark(b.phone), ok: false });
      if (locked) await sec(req, { event: 'login.locked', target: phoneMark(b.phone), ok: false });
      reply.code(401); return { error: 'Wrong phone or PIN' };
    }
    await clearHits(pool, [pair, onePhone]);
    // the same phone under two distributors: the app shows "Which firm?" and sends tenantId
    if (ok.length > 1) return { choose: ok.map(u => ({ tenantId: u.tenant_id, firm: u.firm })) };
    const u = ok[0];
    await pool.query('UPDATE users SET last_login = now() WHERE tenant_id=$1 AND id=$2', [u.tenant_id, u.id]);
    await sec(req, { tenant: u.tenant_id, actor: u.id, role: u.role, event: 'login.ok' });
    // an owner or head office still on a 4-digit PIN is asked to set 6 digits now (owner decision, 13 Nov 2026)
    const mustChangePin = Number(u.pin_len ?? 4) < pinLength(u.role);
    return { tenantId: u.tenant_id, userId: u.id, role: u.role, token: signToken({ t: u.tenant_id, u: u.id, r: u.role, e: u.token_epoch }), licence: await licenceFor(u.tenant_id), ...(mustChangePin ? { mustChangePin: true, pinLength: pinLength(u.role) } : {}) };
  });

  // Numbers are issued here, never on the phone: one running series per distributor, no duplicates across phones.
  app.post('/v1/number', async req => {
    const c = await auth(req);
    perUser(c, 'number', R.number);
    const b = req.body as { kind?: 'bill' | 'cn' | 'receipt'; count?: number };
    const kind = b.kind ?? 'bill';
    // company head office: credit-note numbers for claim settlements only
    // credit notes: every role that can make one (returns at the door, in the shop, at the godown; head office claims)
    const cnRoles = ['owner', 'office', 'salesman', 'delivery', 'godown', 'cadmin'];
    // collection receipts: everyone who collects money (salesman, delivery) numbers their own receipts
    const receiptRoles = ['owner', 'office', 'salesman', 'delivery'];
    if (!(c.r === 'owner' || c.r === 'office' || (kind === 'cn' && cnRoles.includes(c.r)) || (kind === 'receipt' && receiptRoles.includes(c.r)))) throw err(403, 'Only the owner or office can make bills'); const n = Math.min(Math.max(1, Number(b.count ?? 1)), 20);
    const st = await stateFor(c.t);
    if (st?.status === 'locked' && kind === 'bill') throw err(402, LOCKED_MSG);
    if (st && kind === 'bill' && !st.mods.has('bill')) throw err(403, 'Billing is not in your plan.');
    const col = kind === 'bill' ? 'next_bill_no' : kind === 'cn' ? 'next_cn_no' : 'next_receipt_no';
    const r = await pool.query(`UPDATE tenants SET ${col} = ${col} + $2 WHERE id=$1 RETURNING ${col} - $2 AS first, prefix`, [c.t, n]);
    if (!r.rows[0]) throw err(404, 'Distributor not found');
    return { first: Number(r.rows[0].first), count: n, prefix: r.rows[0].prefix ?? 'DBX' };
  });

  // Sync: push this phone's changes, pull everything newer than the phone's cursor.
  app.post('/v1/sync', async req => {
    const c = await auth(req);
    perUser(c, 'sync', R.sync);
    const b = req.body as { cursor?: number; moves?: number; tables?: unknown; changes?: { table: string; id: string; updatedAt: string; data: Record<string, unknown> }[] };
    // a phone that sends stock as movements (this app); an older app sends whole lots (see 'batches' below)
    const movesPhone = b.moves === 1;
    const changes = (Array.isArray(b.changes) ? b.changes : []).slice(0, 2000);
    const canWrite = new Set(WRITE[c.r] ?? []);
    const accepted: string[] = [];
    const rejected: string[] = [];
    // why a record was refused, in plain words the phone shows (only for the rules a person can act on)
    const reasons: Record<string, string> = {};
    let freshToken: string | null = null;
    // the server's own copy of every refused or ignored record goes back, so the phone corrects itself
    const current: { table: string; id: string; updatedAt: string; data: Record<string, unknown> }[] = [];
    // read before taking the lock: a lock holder that waits for a second pooled connection can freeze the server
    const st = changes.length ? await stateFor(c.t) : null;
    const kind = changes.length ? await tenantKind(pool, c.t) : 'distributor';
    // nothing to save ("anything new?"): no transaction and no lock, straight to the pull
    const staffEvents: SecEvent[] = [];
    if (changes.length) {
    const written: { table: string; id: string }[] = [];
    let queued = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // one writer per distributor at a time → versions commit in order, so no phone ever skips a change
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [c.t]);
      // the stored copy of every record in this push (one query): rules compare against it
      const valid = changes.filter(ch => ch && typeof ch.table === 'string' && typeof ch.id === 'string' && ch.id.length > 0 && ch.id.length <= 300);
      const stored = new Map<string, { data: Record<string, unknown>; updated_at: Date }>();
      if (valid.length) for (const r of (await client.query(`SELECT tbl, id, data, updated_at FROM docs WHERE tenant_id=$1 AND (tbl, id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
        [c.t, valid.map(v => v.table), valid.map(v => v.id)])).rows) stored.set(`${r.tbl}|${r.id}`, { data: r.data, updated_at: r.updated_at });
      const blockNew = st?.status === 'locked' ? new Set(['orders', 'invoices']) : new Set<string>();
      const archived = new Set<string>();
      if (blockNew.size) {
        const want = valid.filter(ch => blockNew.has(ch.table) && !stored.has(`${ch.table}|${ch.id}`));
        if (want.length) for (const r of (await client.query(`SELECT tbl, id FROM docs_archive_ids WHERE tenant_id=$1 AND tbl = ANY($2) AND id = ANY($3)`,
          [c.t, [...blockNew], want.map(w => w.id)])).rows) archived.add(`${r.tbl}|${r.id}`); // an old bill in the archive is not new
      }
      // the newest copy of a record wins inside one push too (a record twice in one statement would fail the batch)
      const last = new Map<string, number>(); changes.forEach((ch, i) => { const k = `${ch?.table}|${ch?.id}`; const j = last.get(k); if (j === undefined || String(changes[j].updatedAt) <= String(ch.updatedAt)) last.set(k, i); });
      const now = Date.now();
      const rows: { table: string; id: string; data: string; up: string }[] = [];
      const refuse = (key: string, why?: string | null) => { rejected.push(key); if (why) reasons[key] = why; };
      // too big, or a clock running ahead: not about the rules, so the phone keeps its own copy (held, tried again later —
      // a clock a few minutes fast goes through once real time catches up) instead of being given the server's copy
      const keepTheirs = new Set<string>();
      // stock movements to apply after the records are saved (a new lot first): key = the phone's record, or null for a
      // movement the server makes itself (a whole lot from an older app)
      const moves: { key: string | null; id: string; data: Record<string, unknown>; up: string }[] = [];
      for (const [i, ch] of changes.entries()) {
        const key = `${ch?.table}|${ch?.id}`;
        if (!ch || typeof ch.table !== 'string' || relayOnly(kind, ch.table)) { refuse(key); continue; } // only the relay writes these (privacy wall)
        if (!canWrite.has(ch.table) || typeof ch.id !== 'string' || !ch.id || ch.id.length > 300 || typeof ch.updatedAt !== 'string' || isNaN(Date.parse(ch.updatedAt))) { refuse(key); continue; }
        if (last.get(key) !== i) { accepted.push(key); continue; } // an older copy in the same push
        // a clock far ahead would make this copy win over every later fix
        if (Date.parse(ch.updatedAt) > now + CLOCK_AHEAD_MS) { refuse(key); keepTheirs.add(key); continue; }
        const ex = stored.get(key)?.data;
        let data: Record<string, unknown> = { ...(ch.data && typeof ch.data === 'object' ? ch.data : {}), tenantId: c.t, id: ch.id };
        if (Buffer.byteLength(JSON.stringify(data)) > DOC_MAX) { refuse(key); keepTheirs.add(key); continue; }
        // a locked plan takes no NEW orders or bills, except ones dated before the lock day (made offline in grace)
        if (blockNew.has(ch.table) && !ex && !archived.has(key) && !(typeof data.date === 'string' && st && data.date < st.lockOn)) { refuse(key); continue; }
        // TESRAX report counts are the proof behind its claims: a phone writes only its own signed-in user's days, one
        // record per phone (staffId|day|device), and the report adds the phones up
        if (ch.table === 'tesraxDays' && (data.staffId !== c.u || !ch.id.startsWith(`${c.u}|${String(data.day)}|`) || ch.id.length === `${c.u}|${String(data.day)}|`.length)) { refuse(key); continue; }
        // the history log is add-only, for everyone
        if (ch.table === 'audit' && ex) { refuse(key); continue; }
        // and never keeps a PIN (an older app copied a new staff member's PIN into it — found 13 Nov 2026)
        if (ch.table === 'audit') for (const side of ['before', 'after']) { const v = data[side] as Record<string, unknown> | null; if (v && typeof v === 'object' && 'pin' in v) { const { pin: _p, ...rest } = v; void _p; data[side] = rest; } }
        // the server's own checks on company records and linked products (approvals and prices are never the phone's word)
        if (kind === 'company' && ['claimDecisions', 'travelClaims', 'expenses', 'leaves', 'workDays'].includes(ch.table)) {
          if (companyRule(c.r, c.u, ch.table, { ...data, updatedAt: ch.updatedAt } as never, ex as never, ch.updatedAt)) { refuse(key); continue; }
        }
        // every money amount is a real number, whoever sends it (a NaN or text never reaches the books)
        if (badMoney(ch.table, data)) { refuse(key); continue; }
        // a company rep writes only his own orders, at the product's rate (pushed, not only downloaded)
        if (kind === 'company' && ch.table === 'orders' && c.r === 'rep') {
          const why = data.repId !== c.u || (ex && ex.repId !== c.u) ? 'a rep changes only his own orders'
            : orderRates(c.r, data, ex, await productRates(client, c.t, data));
          if (why) { refuse(key, why); continue; }
        }
        if (kind === 'distributor') {
          const no = distributorRule(c.r, c.u, ch.table, data, ex) ?? badLines(ch.table, data);
          if (no) { refuse(key, no); continue; }
          if (ch.table === 'orders' && c.r !== 'owner' && c.r !== 'office') {
            const why = orderRates(c.r, data, ex, await productRates(client, c.t, data));
            if (why) { refuse(key, why); continue; }
          }
          // a van number belongs to one van in use (the app's guard, held here too)
          if (ch.table === 'vans' && data.active !== false && vanKey(data.number)) {
            const k = vanKey(data.number);
            const pushed = rows.filter(r => r.table === 'vans' && r.id !== ch.id).map(r => JSON.parse(r.data) as Record<string, unknown>);
            const twin = pushed.some(v => v.active !== false && vanKey(v.number) === k)
              || (await client.query(`SELECT 1 FROM docs WHERE tenant_id=$1 AND tbl='vans' AND id <> ALL($2::text[]) AND COALESCE(data->>'active','true') <> 'false' AND upper(regexp_replace(COALESCE(data->>'number',''), '[^A-Za-z0-9]', '', 'g'))=$3 LIMIT 1`,
                [c.t, [ch.id, ...pushed.map(v => String(v.id))], k])).rowCount;
            if (twin) { refuse(key, 'this van number is already used by another van'); continue; }
          }
          if (ch.table === 'invoices' && (!billAddsUp(data) || !billLotsOk(data))) { refuse(key); continue; }
          // a bill's credit notes together never come to more than it charged (the bill and earlier notes, here or in this push)
          if (ch.table === 'creditNotes') {
            const invId = String(data.invoiceId ?? '');
            const pushedBill = rows.filter(r => r.table === 'invoices' && r.id === invId).pop();
            const bill = pushedBill ? JSON.parse(pushedBill.data) as Record<string, unknown> : stored.get(`invoices|${invId}`)?.data
              ?? (await client.query(`SELECT data FROM docs WHERE tenant_id=$1 AND tbl='invoices' AND id=$2`, [c.t, invId])).rows[0]?.data;
            const here = rows.filter(r => r.table === 'creditNotes' && r.id !== ch.id).map(r => JSON.parse(r.data) as Record<string, unknown>).filter(x => x.invoiceId === invId);
            const before = Number((await client.query(`SELECT COALESCE(sum((data->>'total')::numeric), 0) AS t FROM docs WHERE tenant_id=$1 AND tbl='creditNotes' AND data->>'invoiceId'=$2 AND id <> ALL($3::text[])`,
              [c.t, invId, [ch.id, ...here.map(x => String(x.id))]])).rows[0].t);
            if (creditNoteRoom(data, bill, before + here.reduce((a, x) => a + Number(x.total ?? 0), 0))) { refuse(key); continue; }
          }
          // the same company bill number is entered once per company
          if (ch.table === 'purchases' && String(data.billNo ?? '').trim()) {
            const no = String(data.billNo).trim().toUpperCase(), co = String(data.companyId ?? '');
            const pushed = rows.filter(r => r.table === 'purchases' && r.id !== ch.id).map(r => JSON.parse(r.data) as Record<string, unknown>);
            const twin = pushed.some(x => String(x.companyId ?? '') === co && String(x.billNo ?? '').trim().toUpperCase() === no)
              || (await client.query(`SELECT 1 FROM docs WHERE tenant_id=$1 AND tbl='purchases' AND id <> ALL($2::text[]) AND data->>'companyId'=$3 AND upper(btrim(data->>'billNo'))=$4 LIMIT 1`,
                [c.t, [ch.id, ...pushed.map(x => String(x.id))], co, no])).rowCount;
            if (twin) { refuse(key); continue; }
          }
          if (ch.table === 'products') data = keepCompanyFields(data as never, ex as never);
          // an owner or office copy made before the driver's delivery result never wipes it
          if (ch.table === 'invoices') data = keepDeliveryResult(c.r, data, ex);
          if (ch.table === 'orders') data = stampActivity(c.u, keepLineNumbers(data, ex), ex); // an older phone never wipes order line numbers; history in the signed-in name
          if (ch.table === 'shops') data = keepCreditLimit(c.r, data, ex);
        }
        data = keepOwnerOnly(c.r, OWNER_ONLY[ch.table], data, ex);
        // a collection receipt number: issued by this server and used once (a receipt still waiting for its number may sync)
        if (ch.table === 'payments' && typeof data.receiptNo === 'string' && data.receiptNo && !data.receiptNo.includes('/PENDING-') && (!ex || ex.receiptNo !== data.receiptNo)) {
          const num = data.receiptNo;
          const mine = (await client.query('SELECT doc_id FROM doc_numbers WHERE tenant_id=$1 AND tbl=$2 AND number=$3', [c.t, 'paymentReceipts', num])).rows[0];
          if (mine ? mine.doc_id !== ch.id : !(await numberIssued(client, c.t, 'receipts', num))) { refuse(key); continue; }
          if (!mine) await client.query('INSERT INTO doc_numbers(tenant_id, tbl, number, doc_id) VALUES ($1,$2,$3,$4)', [c.t, 'paymentReceipts', num, ch.id]);
        }
        // bill and credit-note numbers: issued by this server, and each used by one record only, for ever
        if ((ch.table === 'invoices' || ch.table === 'creditNotes') && (!ex || ex.number !== data.number)) {
          const num = String(data.number ?? '');
          const mine = (await client.query('SELECT doc_id FROM doc_numbers WHERE tenant_id=$1 AND tbl=$2 AND number=$3', [c.t, ch.table, num])).rows[0];
          if (mine ? mine.doc_id !== ch.id : !(await numberIssued(client, c.t, ch.table, num))) { refuse(key); continue; }
          if (!mine) await client.query('INSERT INTO doc_numbers(tenant_id, tbl, number, doc_id) VALUES ($1,$2,$3,$4)', [c.t, ch.table, num, ch.id]);
        }
        if (ch.table === 'staff') {
          if (c.r !== 'owner' && c.r !== 'cadmin') { refuse(key); continue; }
          // a login problem (phone used by someone else, an easy PIN) refuses this record only, never the whole sync
          await client.query('SAVEPOINT staff');
          try {
            const r = await upsertStaffLogin(client, c.t, data, kind);
            if (!r.ok) { await client.query('ROLLBACK TO SAVEPOINT staff'); refuse(key); staffEvents.push({ event: 'staff.refused', target: ch.id, ok: false, detail: { role: String(data.role ?? '') } }); continue; }
            await client.query('RELEASE SAVEPOINT staff');
            if (r.change) staffEvents.push({ event: `staff.${r.change}`, target: ch.id, detail: { role: String(data.role ?? ''), pinChanged: !!r.pinChanged } });
            if (ch.id === c.u && r.epoch !== undefined && r.epoch !== c.e) freshToken = signToken({ t: c.t, u: c.u, r: c.r, e: r.epoch }); // own PIN/phone changed
          } catch (e) { await client.query('ROLLBACK TO SAVEPOINT staff'); app.log.warn({ code: CODE(e) }, 'staff login'); refuse(key); continue; }
          data.pin = ''; // never store PINs inside documents
        }
        // STOCK: a movement is add-only (sent again → already counted); it is applied below, after the lots are saved
        if (ch.table === 'stockMoves') {
          if (ex) { accepted.push(key); continue; }
          if (badMove(data)) { refuse(key); continue; }
          moves.push({ key, id: ch.id, data: { ...data, by: c.u }, up: ch.updatedAt });
          continue;
        }
        // a lot record never sets the qty: the server's qty (the sum of the lot's movements) stays. An older app (no
        // movements) or a lot marked legacyQty (changed on a phone before it updated, never sent) still wins as a whole
        // lot, as before — kept as a movement of the difference, so qty = sum of movements always holds.
        if (ch.table === 'batches') {
          const was = ex && Number.isFinite(Number(ex.qty)) ? Number(ex.qty) : 0, theirs = Number(data.qty);
          const legacy = !movesPhone || data.legacyQty === true;
          delete data.legacyQty;
          data.qty = was;
          const s0 = stored.get(key);
          if (legacy && Number.isInteger(theirs) && theirs !== was && (!s0 || new Date(s0.updated_at).getTime() <= Date.parse(ch.updatedAt))) {
            const at = new Date().toISOString();
            moves.push({ key: null, id: `whole:${ch.id}:${newId()}`, up: at, data: { batchId: ch.id, productId: data.productId, delta: theirs - was, reason: 'whole lot (older app)', by: c.u, at, createdAt: at, updatedAt: at } });
          }
        }
        rows.push({ table: ch.table, id: ch.id, data: JSON.stringify(data), up: ch.updatedAt });
        accepted.push(key); // older copies are accepted but ignored: newest already stored (its copy goes back below)
      }
      if (rows.length) {
        // one statement for the whole batch (fast at scale); newest updatedAt wins
        const done = (await client.query(
          `INSERT INTO docs(tenant_id,tbl,id,data,updated_at)
           SELECT $1, t, i, d::jsonb, u::timestamptz FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS x(t, i, d, u)
           ON CONFLICT (tenant_id,tbl,id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at, version=nextval('docs_version_seq')
           WHERE docs.updated_at <= EXCLUDED.updated_at RETURNING tbl, id`,
          [c.t, rows.map(r => r.table), rows.map(r => r.id), rows.map(r => r.data), rows.map(r => r.up)])).rows;
        written.push(...done.map(r => ({ table: r.tbl as string, id: r.id as string })));
      }
      // STOCK MOVEMENTS: qty = qty + delta, in this transaction. Pieces coming in first (a push may carry stock in and
      // the bill that uses it); a movement that would take a lot below zero is refused — that record only.
      const lotsTouched = new Set(rows.filter(r => r.table === 'batches').map(r => r.id));
      for (const m of moves.map((m, i) => ({ m, i })).sort((a, b) => Number(Number(b.m.data.delta) > 0) - Number(Number(a.m.data.delta) > 0) || a.i - b.i).map(x => x.m)) {
        const lotId = String(m.data.batchId), delta = Number(m.data.delta);
        const r = await client.query(`UPDATE docs SET data = jsonb_set(data, '{qty}', to_jsonb(COALESCE((data->>'qty')::numeric, 0)::int + $3::int)), version = nextval('docs_version_seq')
          WHERE tenant_id=$1 AND tbl='batches' AND id=$2 AND COALESCE((data->>'qty')::numeric, 0) + $3::int >= 0 RETURNING id`, [c.t, lotId, delta]);
        if (!r.rowCount) { if (m.key) refuse(m.key); continue; }
        await client.query(`INSERT INTO docs(tenant_id,tbl,id,data,updated_at) VALUES ($1,'stockMoves',$2,$3,$4) ON CONFLICT (tenant_id,tbl,id) DO NOTHING`,
          [c.t, m.id, JSON.stringify({ ...m.data, id: m.id, tenantId: c.t }), m.up]);
        if (m.key) accepted.push(m.key);
        written.push({ table: 'stockMoves', id: m.id });
        if (!lotsTouched.has(lotId)) written.push({ table: 'batches', id: lotId });
        lotsTouched.add(lotId);
      }
      const wrote = new Set(written.map(w => `${w.table}|${w.id}`));
      // only copies this person may read anyway (a company manager or rep: their scope comes with the normal pull)
      const readable = new Set(kind === 'company' && c.r !== 'cadmin' ? [] : READ[c.r] ?? []);
      for (const k of new Set([...rejected, ...accepted.filter(a => !wrote.has(a))])) {
        const s0 = stored.get(k); if (!s0 || keepTheirs.has(k)) continue;
        const [table, ...rest] = k.split('|');
        if (!readable.has(table) || !mayDownload(c.r, c.u, table, s0.data)) continue;
        current.push({ table, id: rest.join('|'), updatedAt: new Date(s0.updated_at).toISOString(), data: forRole(c.r, table, s0.data) });
      }
      // every lot this push touched goes back as the server holds it now (the true qty), so every phone converges
      if (lotsTouched.size && readable.has('batches')) {
        const fresh = (await client.query(`SELECT id, data, updated_at FROM docs WHERE tenant_id=$1 AND tbl='batches' AND id = ANY($2)`, [c.t, [...lotsTouched]])).rows;
        for (const f of fresh) {
          const at = current.findIndex(x => x.table === 'batches' && x.id === f.id); if (at >= 0) current.splice(at, 1);
          current.push({ table: 'batches', id: f.id, updatedAt: new Date(f.updated_at).toISOString(), data: forRole(c.r, 'batches', f.data) });
        }
      }
      // noted for the relay in the same transaction: a crash after the save can't lose them
      queued = await queueRelay(client, c.t, kind, written);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    // the other side of each company link gets what may cross (after the save, under its own lock)
    await afterSave(pool, c.t, kind, written, queued);
    }
    for (const e of staffEvents) await sec(req, { ...e, tenant: c.t, actor: c.u, role: c.r });

    const cursor = Number(b.cursor ?? 0);
    // a brand's phones never download every distributor bill: head office gets reports from the server instead; a
    // manager or rep gets only their own distributors' records, and bills of the last 60 days
    const isCo = (kindCache.get(c.t) ?? (kindCache.set(c.t, await tenantKind(pool, c.t)), kindCache.get(c.t))) === 'company';
    const scope = isCo ? await scopeFor(pool, c.t, c.u) : null;
    // a phone lists the tables its version knows: an older phone, during a staged update, is never sent a table it can't store
    // (a list only narrows what the role may read, never widens it; today's phones send no list and get every table)
    const knows = Array.isArray(b.tables) ? new Set(b.tables.filter((t): t is string => typeof t === 'string')) : null;
    const tables = (READ[c.r] ?? []).filter(t => !(isCo && c.r === 'cadmin' && BIG_TABLES.includes(t)) && (!knows || knows.has(t)));
    // a page is cut by size as well as rows (records with photos): the first row always comes, so it always moves on
    const rows = (await pool.query(
      // the history log is 80% of all data: phones get only its last 3 days (morning summary, undo); the full log stays here.
      // Stock movements too: a lot's true qty comes with the lot itself
      `SELECT tbl, id, data, updated_at, version, run, total FROM (
         SELECT *, sum(sz) OVER (ORDER BY version) AS run, sum(sz) OVER () AS total FROM (
           SELECT tbl, id, data, updated_at, version, pg_column_size(data) AS sz FROM docs WHERE tenant_id=$1 AND version > $2 AND tbl = ANY($3)
             AND (tbl NOT IN ('audit', 'stockMoves') OR updated_at > now() - interval '3 days')
             AND ($5::text[] IS NULL OR tbl <> ALL($6) OR data->>'dbLinkId' = ANY($5))
             AND (NOT $7 OR tbl NOT IN ('secondary','secondaryReturns') OR data->>'date' >= $8)
             -- staff privacy: another person's advances, leaves, expenses, orders or travel claims never reach this phone
             AND NOT EXISTS (SELECT 1 FROM unnest($10::text[], $11::text[]) AS o(t, f) WHERE o.t = tbl AND COALESCE(data->>o.f, '') <> $12)
             ORDER BY version LIMIT $4) a) b
       WHERE run - sz <= $9 ORDER BY version`,
      [c.t, cursor, tables, config.pullLimit, scope, BIG_TABLES, isCo, new Date(Date.now() + 5.5 * 3600e3 - 60 * 86400e3).toISOString().slice(0, 10), config.pullBytes,
        Object.keys(OWN_ROWS[c.r] ?? {}), Object.values(OWN_ROWS[c.r] ?? {}), c.u])).rows;
    const maxVersion = rows.length ? Number(rows[rows.length - 1].version) : cursor;
    const cut = rows.length > 0 && Number(rows[rows.length - 1].run) < Number(rows[rows.length - 1].total);
    // a token running out within 7 days is renewed here (a phone in daily use never has to log in again)
    if (!freshToken && c.exp - Date.now() / 1000 <= RENEW_DAYS * 86400) freshToken = signToken({ t: c.t, u: c.u, r: c.r, e: c.e });
    return {
      cursor: maxVersion,
      licence: await licenceFor(c.t), // every sync renews the phone's licence
      more: rows.length === config.pullLimit || cut,
      accepted, rejected, current, ...(Object.keys(reasons).length ? { reasons } : {}),
      ...(freshToken ? { token: freshToken } : {}),
      // owner-only fields (purchase rate) never reach anyone but the owner
      changes: rows.map(r => ({ table: r.tbl, id: r.id, updatedAt: new Date(r.updated_at).toISOString(), data: forRole(c.r, r.tbl, r.data) })),
    };
  });

  // a stopping server finishes the relay batch in hand first (nothing half-sent)
  app.addHook('onClose', async () => { await relayIdle(); await coverIdle(); });

  // ---------------------------------------------------------------- company reports (answered here, never by downloading every bill)
  const kindCache = new Map<string, 'company' | 'distributor'>();
  const companyUser = async (req: FastifyRequest) => {
    const c = await auth(req);
    if (!['cadmin', 'manager', 'rep'].includes(c.r)) throw err(403, 'Company team only');
    return { c, scope: await scopeFor(pool, c.t, c.u) };
  };
  app.post('/v1/company/report', async req => {
    const { c, scope } = await companyUser(req);
    const b = req.body as { kind?: string; [k: string]: unknown };
    return { data: await companyReport(pool, c.t, scope, String(b.kind ?? ''), b) };
  });
  app.post('/v1/company/docs', async req => {
    const { c, scope } = await companyUser(req);
    const b = req.body as { tbl?: string; ids?: string[]; dbLinkId?: string };
    return { docs: await companyDocs(pool, c.t, scope, String(b.tbl ?? ''), b) };
  });

  // ---------------------------------------------------------------- company links
  // a distributor types the company's invite code: first a preview (who, and exactly what they will see), then accept
  // invite codes can't be guessed: 10 wrong codes → 30 minutes' wait (per distributor)
  const codeFails = new Map<string, { n: number; until: number }>();
  const codeGuard = (t: string) => { const f = codeFails.get(t); if (f && f.until > Date.now()) throw err(429, 'Too many wrong codes. Try again in 30 minutes.'); };
  const codeWrong = (t: string) => { const f = codeFails.get(t) ?? { n: 0, until: 0 }; f.n++; if (f.n >= 10) { f.until = Date.now() + 30 * 60000; f.n = 0; } codeFails.set(t, f); };
  app.post('/v1/link/preview', async req => {
    const c = await auth(req);
    if (c.r !== 'owner' || (await tenantKind(pool, c.t)) !== 'distributor') throw err(403, 'Only the distributor owner can link a company');
    codeGuard(c.t);
    const inv = await findInvite(pool, String((req.body as { code?: string }).code ?? ''));
    if (!inv) { codeWrong(c.t); throw err(404, 'This code is not valid or was already used. Ask the company for a new one.'); }
    return { company: inv.companyName, companyTenant: inv.companyTenant };
  });
  app.post('/v1/link/resync', async req => {
    const c = await auth(req);
    const linkId = String((req.body as { linkId?: string }).linkId ?? '');
    const r = (await pool.query('SELECT company_tenant, db_tenant FROM links WHERE id=$1', [linkId])).rows[0];
    if (!r || !((r.db_tenant === c.t && c.r === 'owner') || (r.company_tenant === c.t && c.r === 'cadmin'))) { await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'tenant.denied', target: 'link/resync', ok: false }); throw err(403, 'Not your link'); }
    await resyncLink(pool, linkId);
    return { ok: true };
  });
  // a company bill is received on one phone only (the first to ask, online)
  app.post('/v1/receipt/claim', async req => {
    const c = await auth(req);
    if (!['owner', 'office', 'godown'].includes(c.r)) throw err(403, 'Not allowed');
    const id = String((req.body as { inboundId?: string }).inboundId ?? '');
    const r = await pool.query('INSERT INTO receipt_claims(tenant_id, inbound_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [c.t, id, c.u]);
    if (!r.rowCount) throw err(409, 'This bill is already being received on another phone.');
    return { ok: true };
  });
  app.post('/v1/link/accept', async req => {
    const c = await auth(req);
    if (c.r !== 'owner' || (await tenantKind(pool, c.t)) !== 'distributor') throw err(403, 'Only the distributor owner can link a company');
    const b = req.body as { code?: string; companyIdInDb?: string };
    codeGuard(c.t);
    const r = await acceptInvite(pool, c.t, String(b.code ?? ''), b.companyIdInDb || undefined).catch(e => { if ((e as { statusCode?: number }).statusCode === 404) codeWrong(c.t); throw e; });
    await pool.query('INSERT INTO access_log(tenant_id, actor, action) VALUES ($1,$2,$3)', [c.t, c.u, `linked company ${r.company}`]);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'link.accept' });
    return r;
  });
  app.post('/v1/link/leave', async req => {
    const c = await auth(req);
    if (c.r !== 'owner') throw err(403, 'Only the distributor owner can do this');
    const r = await leaveLink(pool, c.t, String((req.body as { linkId?: string }).linkId ?? ''));
    await pool.query('INSERT INTO access_log(tenant_id, actor, action) VALUES ($1,$2,$3)', [c.t, c.u, 'left company link']);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'link.leave' });
    return r;
  });

  app.post('/v1/scan', async req => {
    const c = await auth(req);
    const b = req.body as { kind?: ScanKind; file?: string };
    // photo reading costs money per read: the people who enter purchases, expenses and orders in the office only
    if (!['owner', 'office', 'godown'].includes(c.r)) throw err(403, 'Photo reading is for the owner, office and godown.');
    perUser(c, 'scan', R.scan);
    // DPDP: bill photos go to an AI company outside the firm, so this is the owner's own, separate choice (Menu → Privacy)
    if (!(await firmConsent(pool, c.t, 'ai_scan'))) throw err(403, 'AI photo reading is off. The owner can turn it on in Menu → Privacy.');
    if (!b.kind || !['purchase', 'expense', 'order'].includes(b.kind) || !b.file) throw err(400, 'kind and file needed');
    const month = new Date().toISOString().slice(0, 7);
    const plan = (await pool.query('SELECT plan FROM tenants WHERE id=$1', [c.t])).rows[0]?.plan ?? 'all';
    const st = await stateFor(c.t);
    const allowance = st?.status === 'trial' ? config.scanTrial : (config.scanAllowance[plan] ?? 300); // a free trial gets a small allowance
    const used = (await pool.query(
      `INSERT INTO scan_usage(tenant_id, month, count) VALUES ($1,$2,1) ON CONFLICT (tenant_id, month) DO UPDATE SET count = scan_usage.count + 1 RETURNING count`, [c.t, month])).rows[0].count;
    if (used > allowance) throw err(402, 'Monthly photo-reading allowance used up. Send Excel/PDF files, or add a top-up.');
    // one cap for the whole service per day (our AI bill can never run away)
    const today = (await pool.query(`INSERT INTO scan_daily(day, count) VALUES (current_date, 1) ON CONFLICT (day) DO UPDATE SET count = scan_daily.count + 1 RETURNING count`)).rows[0].count;
    if (today > Number(process.env.SCAN_DAILY_CAP ?? 2000)) throw err(429, 'Photo reading is very busy today. Please try tomorrow, or send the Excel/PDF file.');
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'scan', detail: { kind: b.kind } });
    return await scanWithAI(b.kind, b.file);
  });

  app.get('/v1/licence', async req => { const c = await auth(req); return { licence: await licenceFor(c.t) }; });

  // Owner sets up UPI Autopay: we create a Razorpay subscription and send back its payment page.
  app.post('/v1/billing/subscribe', async req => {
    const c = await auth(req);
    if (c.r !== 'owner') throw err(403, 'Only the owner can manage the plan');
    const b = await billingOf(c.t); if (!b) throw err(404, 'Distributor not found');
    const rz = config.razorpay;
    const planId = rz.plans[`${b.tier}:${b.pack}`];
    if (!rz.keyId || !rz.keySecret || !planId) throw err(503, 'Online payment is not set up yet. Please pay by bank transfer; support will mark it paid.');
    const r = await fetch('https://api.razorpay.com/v1/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${rz.keyId}:${rz.keySecret}`).toString('base64') },
      body: JSON.stringify({ plan_id: planId, total_count: 120, customer_notify: 1, notes: { tenantId: c.t, firm: b.name } }),
    });
    const j = await r.json() as { id?: string; short_url?: string; error?: { description?: string } };
    if (!r.ok || !j.id) throw err(502, j.error?.description ?? 'Could not start the payment. Try again.');
    await pool.query('UPDATE tenants SET rzp_subscription_id=$2 WHERE id=$1', [c.t, j.id]);
    return { url: j.short_url };
  });

  // Razorpay tells us about every payment. Signature checked over the exact bytes; each event counted once.
  app.post('/v1/razorpay/webhook', async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const sig = String(req.headers['x-razorpay-signature'] ?? '');
    const secret = config.razorpay.webhookSecret;
    const expect = secret ? createHmac('sha256', secret).update(raw).digest('hex') : '';
    if (!secret || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) { await sec(req, { event: 'razorpay.webhook', ok: false, detail: { why: 'bad signature' } }); reply.code(401); return { error: 'bad signature' }; }
    const body = req.body as { event?: string; payload?: { subscription?: { entity?: { id?: string; current_end?: number; notes?: { tenantId?: string } } }; payment?: { entity?: { id?: string } } } };
    const eventId = String(req.headers['x-razorpay-event-id'] ?? `${body.event}:${body.payload?.payment?.entity?.id ?? body.payload?.subscription?.entity?.id}:${body.payload?.subscription?.entity?.current_end ?? ''}`);
    const sub = body.payload?.subscription?.entity;
    let tenantId = sub?.notes?.tenantId ?? null;
    if (!tenantId && sub?.id) tenantId = (await pool.query('SELECT id FROM tenants WHERE rzp_subscription_id=$1', [sub.id])).rows[0]?.id ?? null;
    const fresh = await pool.query('INSERT INTO payment_events(id, tenant_id, event, body) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id', [eventId, tenantId, body.event ?? '', body]);
    if (!fresh.rowCount) return { ok: true, duplicate: true };
    await sec(req, { tenant: tenantId, actor: 'razorpay', role: 'payment', event: 'razorpay.webhook', detail: { event: body.event ?? '' } });
    if (!tenantId) return { ok: true, ignored: 'no distributor' };
    if ((body.event === 'subscription.charged' || body.event === 'subscription.activated') && sub?.current_end) {
      // paid up to the end of this billing period (Razorpay sends unix seconds); a waiting downgrade starts now
      const until = istToday(sub.current_end * 1000 - 1000);
      await pool.query(`UPDATE tenants SET paid_until = GREATEST(COALESCE(paid_until, $2::date), $2::date),
        pack = COALESCE(pending_pack, pack), tier = COALESCE(pending_tier, tier), pending_pack = NULL, pending_tier = NULL,
        rzp_subscription_id = COALESCE(rzp_subscription_id, $3) WHERE id=$1`, [tenantId, until, sub.id ?? null]);
    }
    // payment failed / halted / cancelled: nothing to do — the dates run out and grace → lock happens by itself
    return { ok: true };
  });

  /** the scheduled jobs' key (deploy/cron-call.sh, from inside the machine), compared in constant time. Wrong keys are
   *  counted per place (5 → 30 minutes' lock) and every refusal is written to the activity log. */
  const cron = async (req: FastifyRequest, job: string, code = 403) => {
    const k = String(req.headers['x-cron-key'] ?? ''), place = `cronkey:${req.ip}`;
    if (await isLocked(pool, [place])) { await sec(req, { event: 'cron.denied', target: job, ok: false, detail: { why: 'locked' } }); throw err(429, 'Too many wrong keys'); }
    const ok = !!config.cronKey && timingSafeEqual(createHash('sha256').update(k).digest(), createHash('sha256').update(config.cronKey).digest());
    if (!ok) { await hit(pool, place, 5, 15, 30); await sec(req, { event: 'cron.denied', target: job, ok: false }); throw err(code, code === 401 ? 'Cron key needed' : 'No'); }
  };
  /** a job's run: job_runs (monitor.sh checks each ran in its window) and, for the daily/monthly ones, the activity log */
  const jobDone = async (req: FastifyRequest, job: string, detail: Record<string, unknown>, quiet = false) => {
    await pool.query(`INSERT INTO job_runs(job, last_at, last_ok_at, ok, detail) VALUES ($1, now(), now(), true, $2)
      ON CONFLICT (job) DO UPDATE SET last_at = now(), last_ok_at = now(), ok = true, detail = EXCLUDED.detail`, [job, JSON.stringify(detail)]);
    if (!quiet) await sec(req, { actor: 'cron', role: 'system', event: `cron.${job}`, detail });
  };
  // ---------------------------------------------------------------- the Hanubix console (our side only)
  /** the console's key: Caddy lets only the founder's addresses reach /v1/admin; here every use and every refusal is
   *  logged, wrong keys are counted per place (5 → 30 minutes' lock), and calls per minute are limited. */
  const admin = async (req: FastifyRequest) => {
    const k = String(req.headers['x-admin-key'] ?? ''), place = `adminkey:${req.ip}`;
    const target = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const tenant = (req.params as { id?: string; tenant?: string } | undefined)?.id ?? (req.params as { tenant?: string } | undefined)?.tenant ?? null;
    if (tooMany(`admin:${req.ip}`, R.admin)) throw err(429, 'Too many requests');
    if (await isLocked(pool, [place])) { await sec(req, { event: 'admin.denied', target, ok: false, detail: { why: 'locked' } }); throw err(429, 'Too many wrong keys. Try again later.'); }
    if (!config.adminKey || k.length !== config.adminKey.length || !timingSafeEqual(Buffer.from(k), Buffer.from(config.adminKey))) {
      await hit(pool, place, 5, 15, 30); await sec(req, { event: 'admin.denied', target, ok: false }); throw err(401, 'Admin key needed');
    }
    await sec(req, { tenant, actor: 'admin', role: 'admin', event: 'admin.ok', target });
  };
  app.get('/v1/admin/tenants', async req => {
    await admin(req);
    const rows = (await pool.query('SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1000')).rows;
    const today = istToday();
    return { tenants: await Promise.all(rows.map(async r => { const b = (await billingOf(r.id))!; return { id: r.id, ...b, ...billingState(b, today) }; })) };
  });
  app.post('/v1/admin/tenants/:id/plan', async req => {
    await admin(req);
    const id = (req.params as { id: string }).id;
    const { tier, pack } = req.body as { tier?: string; pack?: string };
    const b = await billingOf(id); if (!b) throw err(404, 'Distributor not found');
    if (pack && !PACKS[pack]) throw err(400, 'Unknown pack');
    if (tier && !TIERS.includes(tier)) throw err(400, 'Unknown tier');
    const packNow = pack && isUpgrade(b.pack, pack);
    const tierNow = tier && TIERS.indexOf(tier) > TIERS.indexOf(b.tier);
    // upgrades start now; downgrades wait for the end of the paid month
    await pool.query(`UPDATE tenants SET pack = CASE WHEN $2::boolean THEN $3 ELSE pack END, pending_pack = CASE WHEN $3::text IS NOT NULL AND NOT $2::boolean THEN $3 ELSE pending_pack END,
      tier = CASE WHEN $4::boolean THEN $5 ELSE tier END, pending_tier = CASE WHEN $5::text IS NOT NULL AND NOT $4::boolean THEN $5 ELSE pending_tier END WHERE id=$1`,
      [id, !!packNow, pack ?? null, !!tierNow, tier ?? null]);
    return { ok: true, startsNow: { pack: !!packNow, tier: !!tierNow }, billing: await billingOf(id) };
  });
  // a payment received outside Razorpay (bank transfer, cash): mark paid up to a date
  app.post('/v1/admin/tenants/:id/paid', async req => {
    await admin(req);
    const id = (req.params as { id: string }).id;
    const { until } = req.body as { until?: string };
    if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw err(400, 'until must be YYYY-MM-DD');
    await pool.query('UPDATE tenants SET paid_until = GREATEST(COALESCE(paid_until, $2::date), $2::date), pack = COALESCE(pending_pack, pack), tier = COALESCE(pending_tier, tier), pending_pack = NULL, pending_tier = NULL WHERE id=$1', [id, until]);
    return { ok: true, billing: await billingOf(id) };
  });

  // Daily job (deploy/cron-call.sh, 00:05 IST): a downgrade starts once the paid month is over; status kept for reports.
  // safety net for the background relay (deploy/cron-call.sh, every minute): empties anything a stopped instance left behind
  app.post('/v1/cron/relay', async req => {
    await cron(req, 'relay');
    const relayed = await drainRelay(pool);
    await jobDone(req, 'relay', { relayed }, !relayed);
    return { relayed };
  });
  // every few minutes: head office's stock figures for every brand (changed products; everything once a day)
  app.post('/v1/cron/cover', async req => {
    await cron(req, 'cover');
    const { refreshAllCover } = await import('./reports.js');
    const brands = await refreshAllCover(pool);
    await jobDone(req, 'cover', { brands }, true);
    return { brands };
  });

  // daily (deploy/cron-call.sh, 02:00 IST): old records move to the compressed archive (nothing is deleted)
  app.post('/v1/cron/archive', async req => {
    await cron(req, 'archive');
    const r = await archiveAll(pool);
    await jobDone(req, 'archive', r as unknown as Record<string, unknown>);
    return r;
  });

  // ---------------------------------------------------------------- the archive, for a new phone (old bills, so dues and
  // reports stay complete). Only the tables this role reads; owner-only fields removed as in the normal sync.
  const archiveTables = (role: string) => (READ[role] ?? []).filter(t => DB_ARCHIVE.includes(t) && t !== 'audit');
  app.post('/v1/archive/list', async req => {
    const c = await auth(req);
    return { months: await archiveMonths(pool, c.t, archiveTables(c.r)) };
  });
  app.post('/v1/archive/month', async req => {
    const c = await auth(req);
    const b = req.body as { tbl?: string; month?: string };
    const tbl = String(b.tbl ?? ''), month = String(b.month ?? '');
    if (!archiveTables(c.r).includes(tbl) || !/^\d{4}-\d{2}$/.test(month)) { await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'tenant.denied', target: `archive/${tbl}`, ok: false }); throw err(403, 'Not available'); }
    const rows = await archiveMonth(pool, c.t, tbl, month);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'archive.month', target: `${tbl}/${month}`, detail: { rows: rows.length } });
    return { changes: rows.filter(r => mayDownload(c.r, c.u, tbl, r.data)).map(r => ({ table: tbl, id: r.id, updatedAt: r.updatedAt, data: forRole(c.r, tbl, r.data) })) };
  });

  app.post('/v1/cron/daily', async req => {
    await cron(req, 'daily', 401);
    const today = istToday();
    await pool.query(`UPDATE tenants SET pack = COALESCE(pending_pack, pack), tier = COALESCE(pending_tier, tier), pending_pack = NULL, pending_tier = NULL
      WHERE (pending_pack IS NOT NULL OR pending_tier IS NOT NULL) AND COALESCE(paid_until, trial_ends) < $1::date`, [today]);
    const rows = (await pool.query('SELECT id FROM tenants')).rows;
    const reminders: { id: string; status: string; daysLeft: number }[] = [];
    for (const r of rows) {
      const b = (await billingOf(r.id))!; const s = billingState(b, today);
      await pool.query('UPDATE tenants SET status=$2 WHERE id=$1 AND status IS DISTINCT FROM $2', [r.id, s.status]);
      if ((s.status === 'trial' && s.daysLeft === 10) || s.status === 'grace') reminders.push({ id: r.id, status: s.status, daysLeft: s.daysLeft });
    }
    await jobDone(req, 'daily', { tenants: rows.length, reminders: reminders.length });
    return { ok: true, tenants: rows.length, reminders };
  });

  // Owner allows support to see data for 24 hours (Part 12, level 3).
  app.post('/v1/support-access', async req => {
    const c = await auth(req);
    if (c.r !== 'owner') throw err(403, 'Only the owner can allow support access');
    await pool.query(`INSERT INTO support_access(tenant_id, granted_by, expires_at) VALUES ($1,$2, now() + interval '24 hours')`, [c.t, c.u]);
    await pool.query('INSERT INTO access_log(tenant_id, actor, action) VALUES ($1,$2,$3)', [c.t, c.u, 'support access granted 24h']);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'support.grant', detail: { hours: 24 } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- security standard (13 Nov 2026)
  const OWNERISH = (r: string) => r === 'owner' || r === 'cadmin';
  // change my own PIN; the owner and a brand's head office choose 6 digits. Every other phone of this person logs out.
  app.post('/v1/pin/change', { bodyLimit: 16 * 1024 }, async req => {
    const c = await auth(req);
    const b = req.body as { old?: string; pin?: string };
    const place = `pinchange:${c.t}:${c.u}`;
    if (await isLocked(pool, [place])) throw err(429, 'Too many wrong PINs. Try again in a few minutes.');
    const u = (await pool.query('SELECT pin_hash FROM users WHERE tenant_id=$1 AND id=$2', [c.t, c.u])).rows[0];
    if (!u || !verifyPin(String(b.old ?? ''), u.pin_hash)) {
      await hit(pool, place, 5, 15, 15); await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'pin.change', ok: false });
      throw err(401, 'Your current PIN is not right');
    }
    if (!pinFits(c.r, b.pin)) throw err(400, `Choose a ${pinLength(c.r)}-digit PIN`);
    if (weakPin(b.pin!)) throw err(400, `This PIN is too easy to guess (a run, a repeat, a year or a date). Choose another ${pinLength(c.r)}-digit PIN.`);
    if (b.pin === b.old) throw err(400, 'Choose a new PIN, not the one you have now');
    const r = await pool.query('UPDATE users SET pin_hash=$3, pin_len=$4, token_epoch = token_epoch + 1, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING token_epoch', [c.t, c.u, hashPin(b.pin!), b.pin!.length]);
    await clearHits(pool, [place]);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'pin.change' });
    return { ok: true, token: signToken({ t: c.t, u: c.u, r: c.r, e: Number(r.rows[0].token_epoch) }) };
  });
  // "log out everywhere": every phone with my login must log in again
  app.post('/v1/logout-all', async req => {
    const c = await auth(req);
    await pool.query('UPDATE users SET token_epoch = token_epoch + 1 WHERE tenant_id=$1 AND id=$2', [c.t, c.u]);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'logout.all' });
    return { ok: true };
  });
  // the owner's "Lock this phone" on a staff record: that person's phone is logged out at its next contact
  app.post('/v1/staff/lock', async req => {
    const c = await auth(req);
    if (!OWNERISH(c.r)) throw err(403, 'Only the owner can do this');
    const id = String((req.body as { staffId?: string }).staffId ?? '');
    if (!id || id === c.u) throw err(400, 'Choose a staff member');
    const r = await pool.query('UPDATE users SET token_epoch = token_epoch + 1 WHERE tenant_id=$1 AND id=$2', [c.t, id]);
    if (!r.rowCount) throw err(404, 'This person has no login yet');
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'staff.lock', target: id });
    return { ok: true };
  });
  // the owner's own slice of the activity log: who logged in, who changed staff, support access, privacy requests
  const OWNER_EVENTS = ['signup', 'login.ok', 'login.fail', 'pin.change', 'logout.all', 'staff.add', 'staff.change', 'staff.remove', 'staff.lock', 'staff.refused',
    'support.grant', 'support.read', 'consent', 'privacy.export', 'privacy.request', 'privacy.erase', 'link.accept', 'link.leave', 'admin.ok'];
  app.post('/v1/security/activity', async req => {
    const c = await auth(req);
    if (!OWNERISH(c.r)) throw err(403, 'Only the owner can see this');
    const rows = (await pool.query(`SELECT s.at, s.event, s.ok, s.target, s.actor, u.name FROM security_log s LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.actor
      WHERE s.tenant_id = $1 AND s.event = ANY($2) ORDER BY s.id DESC LIMIT 200`, [c.t, OWNER_EVENTS])).rows;
    const names = new Map((await pool.query(`SELECT id, data->>'name' AS name FROM docs WHERE tenant_id=$1 AND tbl='staff'`, [c.t])).rows.map(r => [String(r.id), String(r.name ?? '')]));
    return { rows: rows.map(r => ({ at: new Date(r.at).toISOString(), event: r.event, ok: r.ok,
      who: r.actor === 'admin' ? 'Hanubix support' : r.name ?? names.get(String(r.actor)) ?? '', about: r.target && names.has(String(r.target)) ? names.get(String(r.target)) : '' })) };
  });

  // DPDP: my consents, the notice version, the grievance officer, my requests
  const privacyStatus = async (c: Claims) => ({
    version: PRIVACY_VERSION, consents: await consentsOf(pool, c.t, c.u), firm: { ai_scan: await firmConsent(pool, c.t, 'ai_scan') }, grievance: grievance(),
    nominee: (await pool.query('SELECT name, contact FROM nominees WHERE tenant_id=$1 AND user_id=$2', [c.t, c.u])).rows[0] ?? null,
    requests: (await pool.query(`SELECT id, kind, status, due::text AS due, created_at FROM privacy_requests WHERE tenant_id=$1 AND requester=$2 ORDER BY created_at DESC LIMIT 10`, [c.t, c.u])).rows
      .map(r => ({ id: r.id, kind: r.kind, status: r.status, due: String(r.due), at: new Date(r.created_at).toISOString() })),
  });
  app.post('/v1/privacy/status', async req => privacyStatus(await auth(req)));
  app.post('/v1/privacy/consent', async req => {
    const c = await auth(req);
    const b = req.body as { kind?: string; granted?: boolean; version?: string };
    const kind = String(b.kind ?? '');
    if (!CONSENT_KINDS.includes(kind) || typeof b.granted !== 'boolean') throw err(400, 'Unknown choice');
    if (kind === 'privacy' && (b.version !== PRIVACY_VERSION || !b.granted)) throw err(400, 'Please read the privacy notice and tick the box to continue.');
    if (kind === 'ai_scan' && !OWNERISH(c.r)) throw err(403, 'The owner decides AI photo reading for the firm');
    await addConsent(pool, c.t, c.u, kind, b.granted, req.ip);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'consent', detail: { kind, granted: b.granted } });
    return privacyStatus(c);
  });
  app.post('/v1/privacy/export', async req => {
    const c = await auth(req);
    perUser(c, 'export', 5);
    const data = await exportPerson(pool, c.t, c.u);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'privacy.export' });
    return data;
  });
  const REQUEST_KINDS = ['access', 'correct', 'delete', 'delete_account', 'nominate', 'grievance'];
  app.post('/v1/privacy/request', { bodyLimit: 16 * 1024 }, async req => {
    const c = await auth(req);
    const b = req.body as { kind?: string; note?: string };
    const kind = String(b.kind ?? '');
    if (!REQUEST_KINDS.includes(kind)) throw err(400, 'Unknown request');
    if (kind === 'delete_account' && !OWNERISH(c.r)) throw err(403, 'Only the owner can close the firm\'s account');
    const id = newId();
    const due = (await pool.query(`INSERT INTO privacy_requests(id, tenant_id, requester, kind, subject_kind, subject_id, note, due) VALUES ($1,$2,$3,$4,$5,$3,$6, current_date + $7::int) RETURNING due::text AS due`,
      [id, c.t, c.u, kind, OWNERISH(c.r) ? 'owner' : 'staff', String(b.note ?? '').slice(0, 1000), DUE_DAYS])).rows[0].due;
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'privacy.request', target: id, detail: { kind } });
    return { id, due: String(due) };
  });
  app.post('/v1/privacy/nominee', { bodyLimit: 16 * 1024 }, async req => {
    const c = await auth(req);
    const b = req.body as { name?: string; contact?: string };
    const name = String(b.name ?? '').trim().slice(0, 100), contact = String(b.contact ?? '').trim().slice(0, 100);
    if (!name || !contact) throw err(400, 'Name and phone or email of the person needed');
    await pool.query(`INSERT INTO nominees(tenant_id, user_id, name, contact) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, user_id) DO UPDATE SET name=EXCLUDED.name, contact=EXCLUDED.contact, at=now()`, [c.t, c.u, name, contact]);
    await sec(req, { tenant: c.t, actor: c.u, role: c.r, event: 'privacy.request', detail: { kind: 'nominate' } });
    return privacyStatus(c);
  });
  // the public form (website): shop owners and anyone without a login ask for access, correction or erasure
  app.post('/v1/privacy/public-request', { bodyLimit: 16 * 1024 }, async req => {
    if (await hit(pool, `privacyform:${req.ip}`, R.publicForm + 1, 60, 60) || await isLocked(pool, [`privacyform:${req.ip}`])) throw err(429, 'Too many requests from this connection. Try again in an hour.');
    const b = req.body as { name?: string; contact?: string; firm?: string; kind?: string; note?: string };
    const kind = String(b.kind ?? '');
    if (!['access', 'correct', 'delete', 'grievance'].includes(kind) || !String(b.name ?? '').trim() || !String(b.contact ?? '').trim()) throw err(400, 'Your name, a phone or email to reply to, and what you are asking for are needed');
    const id = newId();
    const note = [`From: ${String(b.name).trim().slice(0, 100)}`, `Firm: ${String(b.firm ?? '').trim().slice(0, 120)}`, String(b.note ?? '').slice(0, 1000)].join('\n');
    const due = (await pool.query(`INSERT INTO privacy_requests(id, requester, contact, kind, subject_kind, note, due) VALUES ($1,'public',$2,$3,'shop',$4, current_date + $5::int) RETURNING due::text AS due`,
      [id, String(b.contact).trim().slice(0, 100), kind, note, DUE_DAYS])).rows[0].due;
    await sec(req, { actor: 'public', role: 'public', event: 'privacy.request', target: id, detail: { kind } });
    return { id, due: String(due), grievance: grievance() };
  });

  // the control panel: privacy requests with due dates; erasure needs the request id typed again (second confirmation)
  app.get('/v1/admin/privacy', async req => {
    await admin(req);
    const rows = (await pool.query(`SELECT id, tenant_id, requester, contact, kind, subject_kind, subject_id, note, status, due::text AS due, (status = 'open' AND due < current_date) AS overdue, created_at
      FROM privacy_requests ORDER BY (status = 'open') DESC, due LIMIT 500`)).rows;
    return { requests: rows };
  });
  app.post('/v1/admin/privacy/:id/erase', async req => {
    await admin(req);
    const id = (req.params as { id: string }).id;
    const b = req.body as { confirm?: string; tenantId?: string; subjectKind?: string; subjectId?: string };
    if (b.confirm !== id) throw err(400, 'Type the request id again to confirm the erasure');
    const r = (await pool.query('SELECT * FROM privacy_requests WHERE id=$1', [id])).rows[0];
    if (!r) throw err(404, 'No such request');
    if (r.status !== 'open') throw err(409, 'This request is already closed');
    const tenant = String(r.tenant_id ?? b.tenantId ?? ''), kind = String(b.subjectKind ?? (r.subject_kind === 'owner' ? 'staff' : r.subject_kind) ?? ''), subject = String(b.subjectId ?? r.subject_id ?? '');
    if (!tenant || !subject || !['staff', 'shop'].includes(kind)) throw err(400, 'Say which firm and which person or shop to erase');
    const counts = await eraseSubject(pool, tenant, kind as 'staff' | 'shop', subject);
    await pool.query(`UPDATE privacy_requests SET status='done', closed_at=now(), result=$2 WHERE id=$1`, [id, JSON.stringify(counts)]);
    await sec(req, { tenant, actor: 'admin', role: 'admin', event: 'privacy.erase', target: id, detail: { kind, ...counts } });
    return { ok: true, ...counts };
  });
  app.post('/v1/admin/privacy/:id/close', async req => {
    await admin(req);
    const id = (req.params as { id: string }).id;
    const b = req.body as { status?: string; note?: string };
    if (!['done', 'refused'].includes(String(b.status))) throw err(400, 'status: done or refused');
    const r = await pool.query(`UPDATE privacy_requests SET status=$2, closed_at=now(), result=$3 WHERE id=$1 AND status='open'`, [id, b.status, JSON.stringify({ note: String(b.note ?? '').slice(0, 500) })]);
    if (!r.rowCount) throw err(404, 'No open request with this id');
    await sec(req, { actor: 'admin', role: 'admin', event: 'privacy.close', target: id, detail: { status: String(b.status) } });
    return { ok: true };
  });
  // the breach register and "which firms were touched" (docs/security/09-incident-response.md)
  app.get('/v1/admin/breach', async req => { await admin(req); return { breaches: (await pool.query('SELECT * FROM breaches ORDER BY found_at DESC LIMIT 200')).rows }; });
  app.post('/v1/admin/breach', async req => {
    await admin(req);
    const b = req.body as { summary?: string; severity?: string; tenants?: string[] };
    if (!String(b.summary ?? '').trim()) throw err(400, 'What happened?');
    const sev = ['low', 'medium', 'high', 'critical'].includes(String(b.severity)) ? String(b.severity) : 'medium';
    const r = (await pool.query('INSERT INTO breaches(summary, severity, tenants) VALUES ($1,$2,$3) RETURNING id', [String(b.summary).slice(0, 2000), sev, Array.isArray(b.tenants) ? b.tenants.map(String) : []])).rows[0];
    await sec(req, { actor: 'admin', role: 'admin', event: 'breach.open', target: String(r.id), detail: { severity: sev } });
    return { id: Number(r.id) };
  });
  app.post('/v1/admin/breach/:id', async req => {
    await admin(req);
    const id = Number((req.params as { id: string }).id);
    const b = req.body as { boardNotified?: boolean; peopleNotified?: boolean; closed?: boolean; note?: string };
    await pool.query(`UPDATE breaches SET board_notified_at = CASE WHEN $2 THEN COALESCE(board_notified_at, now()) ELSE board_notified_at END,
      people_notified_at = CASE WHEN $3 THEN COALESCE(people_notified_at, now()) ELSE people_notified_at END,
      closed_at = CASE WHEN $4 THEN COALESCE(closed_at, now()) ELSE closed_at END,
      notes = CASE WHEN $5::text <> '' THEN notes || jsonb_build_array(jsonb_build_object('at', now(), 'note', $5::text)) ELSE notes END WHERE id=$1`,
      [id, !!b.boardNotified, !!b.peopleNotified, !!b.closed, String(b.note ?? '').slice(0, 2000)]);
    await sec(req, { actor: 'admin', role: 'admin', event: 'breach.update', target: String(id), detail: { board: !!b.boardNotified, people: !!b.peopleNotified, closed: !!b.closed } });
    return { ok: true };
  });
  app.post('/v1/admin/breach/affected', async req => {
    await admin(req);
    const b = req.body as { from?: string; to?: string; ip?: string; actor?: string };
    if (!b.from || !b.to || isNaN(Date.parse(b.from)) || isNaN(Date.parse(b.to))) throw err(400, 'from and to (date and time) needed');
    const rows = (await pool.query(`SELECT s.tenant_id, t.name, count(*)::int AS events, min(s.at) AS first, max(s.at) AS last FROM security_log s LEFT JOIN tenants t ON t.id = s.tenant_id
      WHERE s.at BETWEEN $1 AND $2 AND s.tenant_id IS NOT NULL AND ($3::text IS NULL OR s.ip = $3) AND ($4::text IS NULL OR s.actor = $4)
      GROUP BY 1, 2 ORDER BY events DESC`, [b.from, b.to, b.ip ?? null, b.actor ?? null])).rows;
    return { tenants: rows };
  });
  // support may read a firm's records only inside the owner's 24-hour window; every read and refusal is logged
  app.post('/v1/admin/support/:tenant/docs', async req => {
    await admin(req);
    const tenant = (req.params as { tenant: string }).tenant;
    const b = req.body as { tbl?: string; limit?: number };
    const open = (await pool.query('SELECT 1 FROM support_access WHERE tenant_id=$1 AND expires_at > now() LIMIT 1', [tenant])).rowCount;
    if (!open) { await sec(req, { tenant, actor: 'admin', role: 'support', event: 'support.denied', ok: false }); throw err(403, 'No support access: the owner has not allowed it, or the 24 hours are over'); }
    const tbl = String(b.tbl ?? '');
    if (!(READ.office ?? []).includes(tbl)) throw err(400, 'Unknown table');
    const rows = (await pool.query('SELECT id, data, updated_at FROM docs WHERE tenant_id=$1 AND tbl=$2 ORDER BY updated_at DESC LIMIT $3', [tenant, tbl, Math.min(Math.max(1, Number(b.limit ?? 50)), 200)])).rows;
    await sec(req, { tenant, actor: 'admin', role: 'support', event: 'support.read', target: tbl, detail: { rows: rows.length } });
    return { docs: rows.map(r => ({ id: r.id, updatedAt: new Date(r.updated_at).toISOString(), data: forRole('office', tbl, r.data) })) };
  });
  app.post('/v1/admin/seclog/verify', async req => {
    await admin(req);
    const r = (await pool.query('SELECT seclog_verify() AS id')).rows[0].id;
    return { whole: r === null, brokenAt: r === null ? null : Number(r) };
  });

  // monthly (1st, 03:30 IST): retention — small tables purged, activity-log months over 12 exported then dropped,
  // archived months over 5 years removed. {"dryRun": true} only counts. Bills and payments are never touched here.
  app.post('/v1/cron/retention', async req => {
    await cron(req, 'retention');
    const dry = !!(req.body as { dryRun?: boolean } | undefined)?.dryRun;
    const counts = await retention(pool, dry);
    const log = await rotateLog(owner, new Date(), 12, 5, dry);
    await jobDone(req, dry ? 'retention-dry' : 'retention', { ...counts, logMonths: log.archivedMonths.length, logArchiveRemoved: log.archiveRemoved });
    return { dry, counts, log };
  });

  app.setErrorHandler((e: Error & { statusCode?: number }, _req, reply) => {
    const code = e.statusCode ?? 500;
    if (code >= 500) app.log.error({ code: CODE(e), url: _req.url }, 'server error'); // the code only: a full database error can carry customer data
    reply.code(code).send({ error: code >= 500 && process.env.NODE_ENV === 'production' ? 'Server error' : e.message });
  });
  return app;
}

const SIGNUP_PER_HOUR = 5;
const ROLES = { distributor: ['owner', 'office', 'salesman', 'godown', 'delivery'], company: ['cadmin', 'manager', 'rep'] };
/** the login row of a staff record, looked up by the staff id (never by phone): a phone change moves the login, a PIN or
 *  phone change logs the old phone out (token epoch +1). A clash or an easy new PIN refuses this record only. */
async function upsertStaffLogin(client: pg.PoolClient, tenantId: string, s: Record<string, unknown>, kind: 'company' | 'distributor'): Promise<{ ok: boolean; epoch?: number; change?: 'add' | 'change' | 'remove'; pinChanged?: boolean }> {
  const phone = String(s.phone ?? '');
  const role = String(s.role ?? '');
  if (!/^\d{10}$/.test(phone) || !ROLES[kind].includes(role)) return { ok: true }; // a company role never exists inside a distributor, nor the reverse
  const pin = String(s.pin ?? '');
  const id = String(s.id);
  // the same phone may exist under another distributor (a salesman serving two DBs); each firm has its own login row
  const byId = (await client.query('SELECT phone, role, active, pin_hash, token_epoch FROM users WHERE tenant_id=$1 AND id=$2', [tenantId, id])).rows[0];
  const byPhone = (await client.query('SELECT id, active FROM users WHERE tenant_id=$1 AND phone=$2 AND id <> $3', [tenantId, phone, id])).rows[0];
  if (byPhone) {
    if (byPhone.active) return { ok: false }; // two people of one firm can't share a login phone
    await client.query('DELETE FROM users WHERE tenant_id=$1 AND id=$2', [tenantId, byPhone.id]); // a removed person's old login: the phone is free again
  }
  // PIN length by role: the owner and head office 6 digits, staff 4 (owner decision, 13 Nov 2026)
  if (!byId) {
    if (!pinFits(role, pin)) return { ok: true };
    if (weakPin(pin)) return { ok: false };
    await client.query('INSERT INTO users(tenant_id,id,phone,name,role,pin_hash,pin_len,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [tenantId, id, phone, s.name, role, hashPin(pin), pin.length, s.active !== false]);
    return { ok: true, epoch: 0, change: 'add', pinChanged: true };
  }
  // the same PIN sent again is not a change (existing easy PINs keep working until changed)
  const pinChanged = pinFits(role, pin) && !verifyPin(pin, byId.pin_hash);
  if (pinChanged && weakPin(pin)) return { ok: false };
  const bump = pinChanged || byId.phone !== phone || (byId.active && s.active === false) ? 1 : 0;
  const r = await client.query(
    `UPDATE users SET phone=$3, name=$4, role=$5, active=$6, pin_hash = COALESCE($7, pin_hash), pin_len = CASE WHEN $7::text IS NULL THEN pin_len ELSE $9 END, token_epoch = token_epoch + $8, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING token_epoch`,
    [tenantId, id, phone, s.name, role, s.active !== false, pinChanged ? hashPin(pin) : null, bump, pin.length]);
  const change = byId.active && s.active === false ? 'remove' as const
    : pinChanged || byId.phone !== phone || byId.role !== role || (!byId.active && s.active !== false) ? 'change' as const : undefined;
  return { ok: true, epoch: Number(r.rows[0].token_epoch), change, pinChanged };
}

/** the stored rate of every product on an order's lines (one query), for the staff-phone rate check */
async function productRates(client: pg.PoolClient, tenantId: string, order: Record<string, unknown>): Promise<(id: string) => number | undefined> {
  const ids = [...new Set((Array.isArray(order.lines) ? order.lines as Record<string, unknown>[] : []).map(l => String(l?.productId ?? '')))];
  const rates = new Map<string, number>();
  if (ids.length) for (const r of (await client.query(`SELECT id, data->>'rate' AS rate FROM docs WHERE tenant_id=$1 AND tbl='products' AND id = ANY($2)`, [tenantId, ids])).rows) {
    const n = Number(r.rate); if (r.rate != null && Number.isFinite(n)) rates.set(r.id, n);
  }
  return id => rates.get(id);
}
