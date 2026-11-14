import type { Product, Shop } from './types';

export const norm = (s: string) =>
  s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// "Four Line 172 pages" and "4 line 172pages" are the same words: number words become digits, "172 pages" one token
const TOKNUM: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', twelve: '12' };
const TOKUNIT = new Set(['g', 'gm', 'gms', 'kg', 'kgs', 'ml', 'l', 'ltr', 'pages', 'pc', 'pcs', 'bags', 'pads']);
function tokens(s: string) {
  const w = norm(s).split(' ').filter(Boolean).map(x => TOKNUM[x] ?? x);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) { if (/^\d+(\.\d+)?$/.test(w[i]) && TOKUNIT.has(w[i + 1])) { out.push(w[i] + w[i + 1]); i++; } else out.push(w[i]); }
  return out;
}

// Simple, explainable similarity: shared words, with partial credit for prefixes ("surf" ~ "surfexcel").
export function similarity(query: string, target: string): number {
  const q = tokens(query), tt = tokens(target);
  if (!q.length || !tt.length) return 0;
  let hit = 0;
  for (const a of q) {
    let best = 0;
    for (const b of tt) {
      if (a === b) best = Math.max(best, 1);
      else { const x = a.match(/^(\d+(?:\.\d+)?)([a-z]+)$/), y = b.match(/^(\d+(?:\.\d+)?)([a-z]+)$/); if (x && y && x[1] === y[1] && x[2][0] === y[2][0]) best = Math.max(best, 0.9); }
      if (best >= 0.9) continue;
      else if (a.length >= 3 && (b.startsWith(a) || a.startsWith(b))) best = Math.max(best, 0.8);
      else if (a.length >= 4 && b.includes(a)) best = Math.max(best, 0.6);
      else if (a.length >= 5 && b.length >= 5 && lev(a, b) === 1) best = Math.max(best, 0.85); // one slip: "lifeboy", "classamte"
    }
    if (best < 0.8 && a.length >= 5 && tt.join('').includes(a)) best = 0.8; // written together: "goodday" ~ "Good Day"
    hit += best;
  }
  return hit / Math.max(q.length, 1);
}

// a pack size written in the message ("100g", "4x125g", "1 kg" → "1kg") must be the product's pack size
const SIZE = /^\d+(\.\d+)?(g|gm|gms|kg|kgs|ml|l|ltr|pc|pcs|pages|bags|pads)$|^\d+x\d+(\.\d+)?(g|ml)$/;
const sizeTokens = (s: string) => tokens(s.replace(/(\d)\s+(g|gm|gms|kg|kgs|ml|l|ltr|pages|pcs)\b/gi, '$1$2')).filter(t => SIZE.test(t)).map(t => t.replace(/gms?$/, 'g').replace(/kgs$/, 'kg').replace(/ltr$/, 'l'));

/**
 * The product a few words mean. Every word typed counts (recall); among equals, the name with fewest extra words wins
 * ("Surf Excel Easy Wash 1kg" over "… 1kg (Promo Pack)"). When two or more products fit the words equally
 * ("surf excel 1kg": Easy Wash or Quick Wash), they come back in `ambiguous` and the caller must ask, never guess.
 */
export function bestProduct(products: Product[], q: string): { product?: Product; score: number; ambiguous?: Product[] } {
  const want = sizeTokens(q);
  let pool = products;
  if (want.length) { const sized = products.filter(p => { const have = sizeTokens(p.name); return want.every(w => have.includes(w)); }); if (sized.length) pool = sized; }
  // a full name typed is exact even when written a little differently ("four"/"4", "10 bags"/"10bags", "pack of 4"/"pack 4")
  const key = (x: string) => tokens(x).filter(w => w !== 'of' && w !== 'and' && w !== 'the').join(' ');
  const nq = key(q);
  const scored: { p: Product; s: number; extra: number }[] = [];
  for (const p of pool) {
    let s = 0, extra = 0;
    for (const n of [p.name, p.code ?? '', ...p.aliases]) {
      if (!n) continue;
      const v = key(n) === nq ? 1.2 : similarity(q, n);
      if (v > s) { s = v; extra = similarity(n, q); }
    }
    if (s > 0) scored.push({ p, s, extra });
  }
  if (!scored.length) return { score: 0 };
  scored.sort((a, b) => b.s - a.s || b.extra - a.extra);
  const top = scored[0];
  // every typed word fits two packs equally ("navratna 100ml": Cool Oil or Almond) → ask; a full name typed wins outright
  const ties = scored.filter(x => Math.abs(x.s - top.s) < 1e-9).map(x => x.p);
  return { product: top.s >= 0.6 ? top.p : undefined, score: top.s, ambiguous: top.s >= 0.6 && top.s < 1.2 && ties.length > 1 ? ties : undefined };
}

// numbers that belong to a product's name ("5 Star", "Total 10", "5 Grain", "3 Roses"), learnt from the catalogue
let GLUE = new Set<string>();
let VOCAB = new Set<string>();      // every word used in a product name ("bar" in "Rin Bar" is a name, not a unit)
let JOINS: string[] = [];           // "hot & sour", "sweet and spicy": an "&" / "and" inside a name never splits a message
let glueKey = '';
const NUMWORD: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', twelve: '12' };
export function learnNames(products: Product[]) {
  const key = `${products.length}|${products[products.length - 1]?.id ?? ''}`;
  if (key === glueKey) return;
  glueKey = key; GLUE = new Set(); VOCAB = new Set(); const joins = new Set<string>();
  for (const p of products) {
    // the message reaches us with number words already turned into digits ("Four Line" → "4 line")
    const t = tokens(p.name).map(w => NUMWORD[w] ?? w);
    for (const w of t) VOCAB.add(w);
    t.forEach((w, i) => {
      const prev = t[i - 1], next = t[i + 1];
      if (/^\d+$/.test(w)) {
        if (i > 0 && !/^\d/.test(prev)) GLUE.add(`${prev} ${w}`);
        if (next && !/^\d/.test(next) && !SIZE.test(next)) GLUE.add(`${w} ${next}`);
      } else if (/^\d+[a-z]+$/.test(w) && i > 0) GLUE.add(`${prev} ${w}`); // "spray 1pc", "refill 10pcs"
    });
    const low = p.name.toLowerCase();
    for (const m of low.matchAll(/([a-z0-9]+)\s+(&|and)\s+([a-z0-9]+)/g)) joins.add(`${m[1]} ${m[2]} ${m[3]}`);
  }
  JOINS = [...joins];
}
/** "&"/"and" that belong to a product name are hidden from message splitting */
const STATIC_JOINS = /\b(profit|p) and (loss|l)\b|\b(plan|cheques?|vans?|staff|travel) and (billing|upi|drivers?|access|expenses)\b/gi;
export function protectNames(t: string): string {
  let out = t.replace(STATIC_JOINS, m => m.replace(/ and /i, ' ＋ '));
  for (const j of JOINS) { const i = out.toLowerCase().indexOf(j); if (i >= 0) out = out.slice(0, i) + j.replace(/ (&|and) /, ' ＋ ') + out.slice(i + j.length); }
  return out;
}

// Generic words in shop names. "Lakshmi" finds "Sri Lakshmi Traders"; "stores" alone finds nothing.
const SHOP_GENERIC = new Set(['sri', 'shree', 'shri', 'new', 'the', 'stores', 'store', 'traders', 'trader', 'mart', 'super', 'market', 'supermarket', 'agency', 'agencies', 'provision', 'provisions', 'kirana', 'wholesale', 'shop', 'enterprises', 'general', 'and', 'co', 'company', 'centre', 'center', 'bros', 'brothers']);

// Tamil forms of address ("anna" = brother, "akka" = sister): people call out to each other with them, they are never a shop
const CALLS = new Set(['anna', 'annan', 'akka', 'thambi', 'thangai', 'anne', 'ayya', 'amma', 'appa', 'macha', 'machan', 'bhai', 'sir', 'madam']);
// words of a shop's name that the person types around it ("stores", "mart") are never a product
const SHOP_TAIL = ['store', 'stores', 'shop', 'traders', 'trader', 'agency', 'agencies', 'provision', 'provisions', 'kirana', 'wholesale', 'enterprises', 'mart'];

/** the product a mistyped word was probably meant to be ("sarf" → Surf Excel…), or none when nothing is close */
export function closeProduct(products: Product[], word: string): Product | undefined {
  const ws = norm(word).split(' ').filter(w => w.length >= 4 && !/\d/.test(w));
  let best: { p: Product; d: number } | undefined;
  for (const p of products) {
    for (const n of [p.name, ...p.aliases]) for (const t of norm(n).split(' ')) {
      if (t.length < 4) continue;
      for (const w of ws) { const d = lev(w, t); if (d <= (w.length >= 6 && t.length >= 6 ? 2 : 1) && (!best || d < best.d)) best = { p, d }; }
    }
  }
  return best?.p;
}

export interface ShopPrefer { salesmanId?: string; day?: string }
export function findShopInText(shops: Shop[], text: string, prefer?: ShopPrefer): { shop?: Shop; rest: string; ties?: Shop[] } {
  const n = ` ${norm(text)} `;
  const areas = new Set(shops.map(s => norm(s.area ?? '')).filter(Boolean));
  const scored: { shop: Shop; score: number; phrase: string }[] = [];
  for (const s of shops) {
    for (const name of [s.name, ...s.aliases]) {
      const nn = norm(name); if (!nn) continue;
      const words = nn.split(' ');
      // 1) the whole name; 2) its first 2+ words ("pennadam wholesale"); 3) its distinctive word ("lakshmi", "selvam")
      if (n.includes(` ${nn} `)) { scored.push({ shop: s, score: 100 + nn.length, phrase: nn }); continue; }
      let hit = false;
      for (let k = words.length - 1; k >= 2 && !hit; k--) { const pre = words.slice(0, k).join(' '); if (n.includes(` ${pre} `)) { scored.push({ shop: s, score: 50 + pre.length, phrase: pre }); hit = true; } }
      if (hit) continue;
      let found = false;
      for (const w of words) if (w.length >= 4 && !SHOP_GENERIC.has(w) && !CALLS.has(w) && !areas.has(w) && n.includes(` ${w} `)) { scored.push({ shop: s, score: 10 + w.length, phrase: w }); found = true; break; }
      if (found) continue;
      // one-letter typo in the distinctive word ("murgan" → Murugan): weaker than an exact hit
      for (const w of words) {
        if (w.length < 5 || SHOP_GENERIC.has(w) || CALLS.has(w) || areas.has(w)) continue;
        const typo = n.trim().split(' ').find(x => x.length >= 5 && !CALLS.has(x) && lev(x, w) === 1);
        if (typo) { scored.push({ shop: s, score: 5 + w.length, phrase: typo }); break; }
      }
    }
  }
  if (!scored.length) return { rest: text };
  scored.sort((a, b) => b.score - a.score);
  // the same name in two shops (e.g. "Sri Murugan Stores" in two towns): the town said, then the salesman's own
  // shop on today's beat; otherwise don't guess — the caller asks, naming the towns
  let best = scored[0].shop;
  const tied = [...new Map(scored.filter(x => x.score === scored[0].score).map(x => [x.shop.id, x.shop])).values()];
  if (tied.length > 1) {
    const one = (list: Shop[]) => list.length === 1 ? list[0] : undefined;
    const byTown = tied.filter(s => s.area && n.includes(` ${norm(s.area)} `));
    const mine = prefer?.salesmanId ? (byTown.length ? byTown : tied).filter(s => s.salesmanId === prefer.salesmanId) : [];
    const today = prefer?.day ? mine.filter(s => s.beat === prefer.day || s.aliases.includes(`beat:${prefer.day}`)) : [];
    const pick = one(byTown) ?? one(mine) ?? one(today);
    if (!pick) return { rest: text, ties: byTown.length > 1 ? byTown : tied };
    best = pick;
  }
  // take the shop's words out of the ORIGINAL text, keeping commas so item lines still split
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let rest = text;
  if (best.area) {
    const town = best.area.trim().split(/\s+/).map(escape).join('[\\s.,-]*');
    for (const name of [best.name, ...best.aliases]) {
      const nm = name.trim().split(/\s+/).map(escape).join('[\\s.,-]*');
      const before = rest; rest = rest.replace(new RegExp(`${nm}[\\s.,-]*${town}(?=[^a-z0-9]|$)`, 'i'), ' ').replace(new RegExp(`${town}[\\s.,-]*${nm}`, 'i'), ' ');
      if (rest !== before) break;
    }
  }
  for (const name of [best.name, ...best.aliases].sort((x, y) => y.length - x.length)) {
    const words = name.trim().split(/\s+/).map(escape).join('[\\s.,-]*');
    rest = rest.replace(new RegExp(words, 'i'), ' ');
  }
  for (const w of norm(best.name).split(' ').concat(scored[0].phrase.split(' '))) if (w.length >= 2) rest = rest.replace(new RegExp(`(^|[^a-z0-9])${escape(w)}(?=[^a-z0-9]|$)`, 'ig'), ' ');
  // a slip in another word of the shop's name ("velan provison") is still the shop's name, never a product
  const nameWords = norm(best.name).split(' ').filter(w => w.length >= 5);
  rest = rest.replace(/[a-z]{5,}/gi, x => nameWords.some(w => lev(x.toLowerCase(), w) === 1) ? ' ' : x);
  // "velan stores ku 5 box…": the shop's own tail word typed after its name is not a product
  rest = rest.replace(/[a-z]+/gi, x => SHOP_TAIL.includes(x.toLowerCase()) && !VOCAB.has(x.toLowerCase()) ? ' ' : x);
  return { shop: best, rest: rest.replace(/^[\s,;:-]+/, '').replace(/\s+/g, ' ') };
}

const CASE_WORDS = ['case', 'cases', 'cs', 'c', 'cse', 'box', 'boxes', 'ctn', 'carton', 'cartons'];
const PCS_WORDS = ['pc', 'pcs', 'piece', 'pieces', 'nos', 'no', 'units', 'unit', 'pkt', 'pkts', 'packet', 'packets', 'bag', 'bags', 'bottle', 'bottles', 'tin', 'tins', 'bar', 'bars'];
const DOZEN_WORDS = ['dozen', 'dozens', 'dz', 'dzn', 'doz'];
// pack sizes are part of the product name, never a quantity: "5kg", "250 g", "172 pages"
const MEASURE = new Set(['kg', 'kgs', 'g', 'gm', 'gms', 'gram', 'grams', 'ml', 'l', 'ltr', 'litre', 'liter', 'pages', 'page', 'mm', 'cm', 'pads']);
const FILLER = new Set(['shop', 'shops', 'and', 'also', 'order', 'orders', 'take', 'new', 'for', 'please', 'pls', 'plz', 'send', 'need', 'needs', 'want', 'wants', 'give', 'of', 'the', 'to', 'x', 'each', 'also', 'more', 'add', 'extra', 'additional', 'another', 'from', 'book', 'booking']);

export interface ParsedLine { text: string; qty: number; unit: 'case' | 'pcs' | 'dozen'; productText: string }
const unitOf = (w: string): ParsedLine['unit'] | null => CASE_WORDS.includes(w) ? 'case' : DOZEN_WORDS.includes(w) ? 'dozen' : PCS_WORDS.includes(w) ? 'pcs' : null;

// "5 case surf, 10 lifebuoy and 2 dozen good day", "surf 2 case lifebuoy 48", "2cs surf 1 dz vim" → lines.
export function parseItemLines(text: string): ParsedLine[] {
  // "2,450" is one number, not two items
  const parts = protectNames(text).replace(/(\d),(\d{3})\b/g, '$1$2').split(/,|\n|;|\+|\s(?:and|also|&)\s(?=\d)/i).map(x => x.replace(/ ＋ /g, ' & ').trim()).filter(Boolean);
  const out: ParsedLine[] = [];
  for (const part of parts) {
    // split glued quantity+unit ("2cs", "1c", "12pcs"), keep pack sizes glued ("5kg", "250g")
    const words0 = norm(part).split(' ');
    const raw = words0.flatMap((w, i) => { const m = w.match(/^(\d+)([a-z]+)$/); return m && !MEASURE.has(m[2]) && unitOf(m[2]) && !GLUE.has(`${words0[i - 1]} ${w}`) ? [m[1], m[2]] : [w]; });
    // a number followed by a measure word belongs to the name ("172 pages", "5 kg")
    const toks: { w: string; num: boolean }[] = [];
    for (let i = 0; i < raw.length; i++) {
      const w = raw[i];
      if (/^\d+(\.\d+)?$/.test(w) && MEASURE.has(raw[i + 1] ?? '')) { toks.push({ w: `${w}${raw[i + 1]}`, num: false }); i++; continue; }
      // "maggi 2 case" stays two cases of Maggi even though "Maggi 2-Minute" has a 2: a unit word after it means quantity
      if (/^\d+$/.test(w) && !unitOf(raw[i + 1] ?? '') && (GLUE.has(`${raw[i - 1]} ${w}`) || GLUE.has(`${w} ${raw[i + 1]}`))) { toks.push({ w, num: false }); continue; }
      // "6 pcs tetley classic 25 bags": a quantity was already given and a name word comes before → "25 bags" is the pack
      if (/^\d+$/.test(w) && unitOf(raw[i + 1] ?? '') && i > 0 && GLUE.has(`${raw[i - 1]} ${w}${raw[i + 1]}`)) { toks.push({ w: `${w}${raw[i + 1]}`, num: false }); i++; continue; }
      if (FILLER.has(w) && !(w.length > 3 && VOCAB.has(w))) continue; // "book" an order, but "Drawing Book"
      toks.push({ w, num: /^\d+(\.\d+)?$/.test(w) });
    }
    if (!toks.some(t => t.num)) continue;
    const items: { qty: number; unit: ParsedLine['unit']; words: string[] }[] = [];
    if (toks[0].num) {
      // quantity first: each number starts an item ("2 case surf excel 1 dozen lifebuoy")
      for (const t of toks) {
        if (t.num) { items.push({ qty: Number(t.w), unit: 'pcs', words: [] }); continue; }
        const it = items[items.length - 1]; const u = unitOf(t.w);
        if (u && !it.words.length) it.unit = u; else it.words.push(t.w);
      }
    } else {
      // quantity after the name: "surf 2 case lifebuoy 48"
      let words: string[] = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (!t.num) { words.push(t.w); continue; }
        const u = unitOf(toks[i + 1]?.w ?? '');
        items.push({ qty: Number(t.w), unit: u ?? 'pcs', words }); words = [];
        if (u) i++;
      }
      if (words.length && items.length) items[items.length - 1].words.push(...words.filter(w => !unitOf(w)));
    }
    for (const it of items) {
      const productText = it.words.filter(w => !unitOf(w) || VOCAB.has(w) || it.words.length === 1).join(' ').trim();
      if (productText && it.qty > 0) out.push({ text: part, qty: it.qty, unit: it.unit, productText });
    }
  }
  return out;
}

export function toPieces(qty: number, unit: ParsedLine['unit'], p: Product) {
  return unit === 'case' ? qty * p.caseSize : unit === 'dozen' ? qty * 12 : qty;
}

export function findAmount(text: string): number | undefined {
  const m = text.replace(/,/g, '').match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d{1,2})?)/i);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- reading messy typing
/** edit distance, two letters swapped counting as one slip ("murgan", "selvma", "annia" ~ Murugan, Selvam, Annai) */
export function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

const ONES: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000 };
/** "one thousand five hundred" → "1500", "twelve" → "12" (voice typing writes numbers as words) */
export function wordsToNumbers(t: string): string {
  const w = t.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < w.length) {
    const lw = w[i].toLowerCase().replace(/[^a-z]/g, '');
    if (ONES[lw] == null && TENS[lw] == null && !(SCALE[lw] && out.length === 0)) { out.push(w[i]); i++; continue; }
    let total = 0, cur = 0, j = i, used = 0;
    while (j < w.length) {
      const x = w[j].toLowerCase().replace(/[^a-z]/g, '');
      if (/^\s+$/.test(w[j]) || x === 'and') { j++; continue; }
      if (ONES[x] != null) cur += ONES[x];
      else if (TENS[x] != null) cur += TENS[x];
      else if (x === 'hundred') cur = (cur || 1) * 100;
      else if (SCALE[x]) { total += (cur || 1) * SCALE[x]; cur = 0; }
      else break;
      used = j + 1; j++;
    }
    if (!used) { out.push(w[i]); i++; continue; }
    out.push(String(total + cur) + w[used - 1].replace(/^[A-Za-z]+/, '')); // keep a comma or full stop typed after it
    // keep the space that followed the last number word
    i = used;
  }
  return out.join('');
}

// shorthand → plain words TESRAX knows (whole words only). English only for launch.
const SAY: [RegExp, string][] = [
  [/\b(rs|inr)\.\s*/gi, 'rs '], [/\b(\d+(?:\.\d+)?)\s?k\b/gi, '__K$1'],
  [/\s*(→|->|=>|-->)\s*/g, ' changed to '],
  [/\b(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs)\b/gi, '__L$1'],
  [/\b(ordr|odr|ordar|oder)\b/gi, 'order'], [/\bphone\s*pe\b/gi, 'phonepe'], [/\b(trdrs|tradrs|trdr|tradr)\b/gi, 'traders'], [/\bcooly\b/gi, 'coolie'],
  [/\bpd\b/gi, 'paid'], [/\b(rcvd|recd|recvd|recieved|receieved|recived|revd)\b/gi, 'received'], [/\bfrm\b/gi, 'from'],
  [/\b(for him|for her|for them|to him|to her|to them)\b/gi, ' '],
  [/\bu\b/gi, 'you'], [/\bamt\b/gi, 'amount'], [/\b(pls|plz|plss)\b/gi, 'please'], [/\b(tmrw|tmr|tmrrw|tomo|tommorow|tomorow)\b/gi, 'tomorrow'],
  [/\bbal\b/gi, 'balance'], [/\bo\/s\b/gi, 'outstanding'], [/\b(qty)\b/gi, 'quantity'],
  [/\b(settled|settle|cleared)\b/gi, 'paid'],
  [/\b(sir|bro|boss|madam|mam)\b/gi, ' '],
  // polite openings add nothing: "can you please book 5 case surf for Kumar Mart", "i want to order 5 case surf"
  [/^\s*(?:(?:can|could|would|will) you\s+)?(?:kindly\s+)?(?:please\s+)?(?=\w)/i, ''], [/^\s*(?:i|we) (?:want|need|would like|wanna|like) to\s+(?=\w)/i, ''],
  // short forms and typing slips for screen, report and file names (round 10)
  [/\b(rpt|reprt|repot|raport)\b/gi, 'report'], [/\b(rpts|reprts|repots)\b/gi, 'reports'], [/\b(rtn|rtrn|retrn|rtns)\b/gi, 'return'],
  [/\b(colln|collctn|collectn|coln|collcn)\b/gi, 'collection'], [/\bstmt\b/gi, 'statement'], [/\b(stk|stok|stck)\b/gi, 'stock'], [/\b(dmg|damge)\b/gi, 'damage'], [/\b(dmgs|damges)\b/gi, 'damages'],
  [/\bagng\b/gi, 'ageing'], [/\b(outstdg|outstndg|outstnding)\b/gi, 'outstanding'], [/\bexp\s+(list|report)\b/gi, 'expense $1'], [/\b(expns|expences|expnses|expnse|expence)\b/gi, 'expenses'],
  [/\bsmry\b/gi, 'summary'], [/\bsalry\b/gi, 'salary'], [/\bsal\s+sheet\b/gi, 'salary sheet'], [/^\s*report\s*$/i, 'reports'], [/\b(attndnce|attendence|attendnce|atendance)\b/gi, 'attendance'], [/\bapprovls\b/gi, 'approvals'],
  [/\b(ordrs|odrs)\b/gi, 'orders'], [/\bpndg\b/gi, 'pending'], [/\bdel\s+(plan|status)\b/gi, 'delivery $1'], [/\bclm\b/gi, 'claim'], [/\btracer\b/gi, 'tracker'],
  [/\b(cheq|cheqs|chqs)\b/gi, 'cheques'], [/\blst\b/gi, 'list'], [/\breconcil\b/gi, 'reconcile'], [/\bday\s+clos\b/gi, 'day close'], [/\bcash\s*flw\b/gi, 'cash flow'], [/\bcashflw\b/gi, 'cashflow'],
  [/\bp\s+n\s+l\b/gi, 'pnl'], [/\bproft\b/gi, 'profit'], [/\b(setings|sttings|settngs|settigs)\b/gi, 'settings'], [/\bstaf\b/gi, 'staff'], [/\b(empolyees|employes|emplyees|empoyees)\b/gi, 'employees'],
  [/\bsubscripton\b/gi, 'subscription'], [/\b(comp|co)\s+(bills?|invoices?)\b/gi, 'company $2'], [/\b(to|from)\s+co\b/gi, '$1 company'], [/\bshps\b/gi, 'shops'],
  [/\b(movrs|movrz)\b/gi, 'movers'], [/\bhi\s+margin\b/gi, 'high margin'], [/\blo\s+margin\b/gi, 'low margin'], [/\b(dybook|dbook|day\s+bk|dayboook)\b/gi, 'day book'],
  [/\bg\s+s\s+t\b/gi, 'gst'], [/\binventry\b/gi, 'inventory'], [/\baccountnt\b/gi, 'accountant'], [/\bpay\s+roll\b/gi, 'payroll'], [/\bpurch\b/gi, 'purchase'], [/\bshet\b/gi, 'sheet'],
  [/\bn\b/gi, 'and'], [/\bclaims?\s+(excel|sheet)\b/gi, 'claim file'],
  // spelling slips staff make every day
  [/\b(desel|deisel|deisal|disel|diesal|dieseal|deasel)\b/gi, 'diesel'],
  // Tamil typed in English letters (Tanglish), as distributor staff type it
  [/\b(petti|petty|peti|pettis)\b/gi, 'case'],
  [/\b(oru|onnu|ondru)\b(?=\s+(case|cs|box|dozen|pcs|pc|bag|bags|packet|pkt)\b)/gi, '1'], [/\b(rendu|randu|rendhu)\b/gi, '2'], [/\bmoonu\b/gi, '3'], [/\bnaalu\b/gi, '4'],
  [/\b(kadai|kada|kadaiku|kadaikku|kadaila|kadaile|kadaiyila)\b/gi, 'shop'],
  [/\b(puthu|pudhu)\b/gi, 'new'],
  [/\b(evlo|evvalavu|yevlo|evalo|evlavu|evalavu|evvlo)\b/gi, 'how much'],
  [/\b(baaki|baki|bakki|baakki)\b/gi, 'balance'],
  [/\b(kudukanum|kodukanum|kudukkanum|kodukkanum|tharanum)\b/gi, 'has to pay'],
  [/\b(thirumba|thirumbi)\s+(kuduthaanga|kuduthanga|kuduthar|kudutha|koduthanga|koduthar|kodutha|kudthanga|kuduthutaanga|kuduthutanga|eduthen|eduthom|vangitten|vangiten)\b/gi, 'returned'],
  [/\b(kuduthaanga|kuduthanga|kuduthar|kudutha|koduthanga|koduthar|kodutha|kudthanga|kuduthutaanga|kuduthutanga|kuduthutar)\b/gi, 'paid'],
  [/\b(vangitten|vaangitten|vangiten|vaangiten|vanginen|vaanginen|vangittom|vaangittom)\b/gi, 'received'],
  [/\b(anuppunga|anupunga|anuppu|anupu|anupunga|kudunga|kodunga)\b/gi, 'send'],
  [/\b(venum|vendum|veenum|venumam)\b/gi, 'need'],
  [/^\s*(illa|illai|ila)\b/gi, 'no'], [/\b(venam|venaam|vendam|vendaam|venda|vaenam|vaendam)\b/gi, 'no need'],
  [/\b(aakku|aakunga|aakkunga|akku|aaku|aakidu|aakkidu)\b/gi, 'make'], [/\b(maathu|maathunga|mathunga|maathidu|maathanum)\b/gi, 'change'],
  [/\b(thappu|thapu|tappu)\b/gi, 'wrong'],
  [/\b(irukka|irukkaa|iruka)\b/gi, 'available'],
  [/\b(enga|yenga)\b/gi, 'where'], [/\b(kitta|kita|kitte)\b/gi, 'with'],
  [/\b(sari|seri|sariya)\b/gi, 'ok'],
  [/\b(vandhuchu|vanthuchu|vandhachu|vanthachu|vandhiruchu|vanthiruchu)\b/gi, 'came'],
  [/(^|\s)(ku|kku|ukku|la|le)(?=\s|$|[,.])/gi, ' '],
];
/** one clean-up pass before TESRAX reads a message */
export function cleanSaid(t: string): string {
  let s = wordsToNumbers(t);
  for (const [rx, to] of SAY) s = s.replace(rx, to);
  s = s.replace(/__K(\d+(?:\.\d+)?)/g, (_, n) => String(Math.round(Number(n) * 1000))).replace(/__L(\d+(?:\.\d+)?)/g, (_, n) => String(Math.round(Number(n) * 100000)));
  // "irukku" (there is) with a number is a count ("good day 990 irukku", read by the stock count); without one it asks
  if (!/\d/.test(s)) s = s.replace(/\b(irukku|iruku|irukkudhu|irukkuthu)\b/gi, 'available');
  // "1500 illa 1400": "illa" (not) after an amount says that amount is wrong → "not 1500 1400"; "owner illa" → "owner not"
  s = s.replace(/(\d+(?:\.\d+)?)\s+(illa|illai|ila)\b/gi, 'not $1').replace(/\b(illa|illai)\b/gi, 'not');
  return s.replace(/\/-/g, ' ').replace(/\s+/g, ' ').trim();
}

const wordRx = new Map<string, RegExp>();
/** whole words only ("rent" is not in "current", "tea" is not in "team"); a plural s/es is allowed */
export const hasWord = (t: string, words: string[]) => words.some(w => {
  if (/[^\x00-\x7f]/.test(w)) return t.includes(w);
  let r = wordRx.get(w);
  if (!r) { r = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?(?=[^a-z0-9]|$)`); wordRx.set(w, r); }
  return r.test(t);
});
