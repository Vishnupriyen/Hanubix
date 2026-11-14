# Handover — where we are (13 Nov 2026, afternoon)

Start of a new chat: read this file, `CLAUDE.md`, `docs/HANUBIX_LOCKED_SIGNATURE.md` and `docs/HANUBIX_PLAN_LOCKED.md`, then carry on.
Branch `apk` (repo Vishnupriyen/Hanubix). The owner wants plain, simple words, one recommendation, and approval before building.

## First thing to do (a new chat)
- **GitHub repo is `Vishnupriyen/Hanubix`** (the old name DBRoX only redirects — attach and push to Hanubix). Branch `apk`.
- **Never take dates, commits or check results from this file — look them up:** `git log --oneline -15` and
  `gh api "repos/Vishnupriyen/Hanubix/actions/runs?branch=apk&per_page=6"` (via check-runner). As of 13 Nov morning: HEAD c95b8dd,
  every check green on GitHub (Quality gate + APK + phone checks on Android 9, 14 and 16 at ca94293).
- **Never draw the app from memory.** Before any picture of a screen, take a real screenshot of the current app (`cd app && npm run
  dev`, Playwright, 412 px) and change only what the picture is about. Facts a drawing must keep:
  - Bottom bar: dark jade–gold, **only two tabs — Home (left) and Menu (right) — with the TESRAX sphere in the middle**. There is
    no Search, Alerts or other tab.
  - The sphere is the animated **particle sphere** (`app/src/ui/TesraxCore.tsx`, glowing, gold particles on dark jade) — never a
    flat or plain circle. The owner: "it is our iconic".
  - Header: the reworked HANUBIX logo (complete B) with RETAIL INTELLIGENCE on Home; back arrow + screen title elsewhere.
  - Montserrat, white background, jade headings and quantities (see docs/HANUBIX_LOCKED_SIGNATURE.md).
- "next" from the owner means: tell him the next waiting item and ask — never start building or drawing without his word.
- **Never make the owner wait on a check.** Long waits (gate, GitHub builds, APK link) run in the background
  (`run_in_background: true`); answer him at once and report when it lands. Don't reinstall packages or browsers that already work.
- **The APK link is ready ~4 minutes after a push** (the "build" job). Send it then — don't wait for the phone check
  ("emulator" job, ~30–40 min); report that separately when it ends.
- **A failed check is never "a one-off".** Find the cause and fix it (regression test first) — a rerun alone hides it.

## 13 Nov 2026
- Open (tester, minor, not reproduced): a save landing just after a wipe commits could leave unsent rows with no token and no
  'access removed' marker (sync.ts ~202) — a later login of another firm could push them; and App.tsx:138 may show "Access removed."
  without the count in that race. Fix in the next part.
- **Security standard approved** (ISO 27001 / SOC 2 now, certificates later; DPDP Act in full): a round after the convenience
  round, before the server takes real data. Full list: docs/HANUBIX_SECURITY_STANDARD.md (top risks: unencrypted backups, no
  real activity log, staff PINs in plain text on phones, no DPDP, cron jobs not set up on Hostinger). Owner decisions in its section 10.
- Home header: HANUBIX logo with RETAIL INTELLIGENCE under it (edge to edge, clear gap); name + dot and firm name stacked
  on the right; long firm names never squeeze the logo. Module names stay generic (Bill, Delivery, …) — owner's decision.
- **Security standard BUILT, TESTED, SIGNED OFF AND PUSHED** (13 Nov; last commit of the round b2fd1e9, full gate + 154 server
  tests green; independent tester and security agent signed off). Status per item: section 0 of docs/HANUBIX_SECURITY_STANDARD.md.
  In short: encrypted backups (age) + restore drill; hash-chained activity log with nightly check and off-site anchor; limited DB
  role; Hostinger cron jobs, monitor, security watch, alerts, monthly access review; hardening script; Caddyfile; gate-tagged
  deploys (Cloud Run workflow gone); two GitHub security workflows (security.yml weekly scan + security-checks.yml on every push);
  phone: PIN hashes only, token in the Android Keystore, app lock, screenshot block, 14-day offline login / 30-day removal, Lock
  phone; owner PIN 6 digits (old owners asked at next login, can't skip by restarting), owner tokens 14 days; DPDP: consent at
  sign-up and first login, Privacy & security screen, public request form, erasure (bill numbers/amounts kept), breach register,
  retention job; 22 written policies in docs/security/ (founder signs each).
  Bugs found by the tester and fixed (each with a regression test): staff PIN copied into the history log; 30-day offline wipe
  deleted unsent bills/payments; "Access removed" wiped unsent work (now: phone keeps it, only the same firm's owner/office can
  log in there to send it, then it is wiped); check-then-wipe race (now one transaction); harden.sh could lock the founder out.
  Founder's answers used: log 12 months online / 5 years archived; 14-day offline lock; 6-digit owner PIN; backup key held offline
  by the founder; grievance officer R. Vishnupriyen; alert channel and GRIEVANCE_EMAIL are settings to fill; privacy notice
  marked "Draft — legal review pending".
  **Still open from the round:** SecurePlugin.java + screenshot block not yet run on a real phone (next APK + phone check must
  confirm); Postgres row-level security (own round, founder decides); owner DB password still reaches the server container
  (corrective action 5 in docs/security/21-…, needs a one-shot migrate container); the minor wipe race above.
- **Usage rules (owner, 13 Nov)** are now in CLAUDE.md ("Using usage wisely"): ask before big jobs, tell the size, parts with his
  yes before each, full gate once per part, cheap models for checks, never wait in the foreground, one Hanubix chat at a time.
- **Founder to do for security**: make the age key (deploy/README.md step 1, private key offline); set DB_APP_PASSWORD,
  ADMIN_ALLOW_IPS, an alert channel and GRIEVANCE_EMAIL in deploy/.env; GCS bucket (Mumbai, write-only account, 35 days);
  run harden.sh + install-cron.sh on the VPS; outside uptime check; first restore drill and breach drill; sign the 22
  policies; lawyer review of the privacy notice (later); delete the old GCP_SA_KEY GitHub secret. Open decision: Postgres
  row-level security (proposed as its own round).
- **Open for the GST & Accounts specialist** (found 13 Nov, not reproduced): `app/tests/regressions.test.ts` "a paid bill
  credited below zero becomes shop advance" failed once in a full gate (UTC step): outstanding showed ₹0 where the test
  expected ₹0.44. It then passed 13 full runs and 40 runs of the test on its own. Likely cause: `shopOutstanding`
  (`app/src/core/ledger.ts`) hides bill balances of ₹0.50 or less, so a 44-paise leftover after the credit is applied to the
  shop's other bills shows as ₹0. What decides whether a leftover appears is probably the random record ids (e.g. which
  stock lot a pick takes). To decide: is hiding ≤ ₹0.50 right for dues and statements? Then make the test deterministic.

## Done today
- Midnight rep fix; credit note after a return + short delivery fix; phone check (Android emulator) runs to the end with time limits.
- TESRAX: every screen by name, every report by name and period (sent as Excel), shop statement file (accounts-reviewed), salary
  sheet, any bill by voice, P&L / GST summary / day close / attendance / trips files (accounts-reviewed labels), company-side reports,
  outstanding by age bucket. Training: 5,364 sentences 95% → 100%; blind check 97% distributor / 92% company, misses fixed.
- Faster gate: tests ~4 min (TESRAX sets once, two halves, both processors). Full gate ~16 min (the 332-screen sweep is the rest).
- Design locked 12 Nov: new HANUBIX logo (complete B), Montserrat, dark jade–gold bottom bar with the glowing sphere (iconic — keep it),
  TESRAX opens on double tap, Powered by TESRAX only on the animated opening screen, Menu (grouped), text one step smaller,
  header below Android's status bar.
- Live vans map: Google's native map on Android when the GitHub secret MAPS_API_KEY is set (free in India); OpenStreetMap until then.
- **Business Boost** (name locked): Menu group for owner and office — offers running now + six services to request (see plan doc).
  Waiting: the owner's WhatsApp number for requests → set as the VITE_SUPPORT_WHATSAPP build value.
- **Updates without stopping the business**: phones tell the server which tables they know (old and new phones share it during a
  staged rollout; a phone fetches a new table's records once after updating); `deploy/` kit for Hostinger — night-only deploy,
  backup first, health check with automatic step-back, `rollback.sh`, nightly checked backup to Google Cloud; migrations only add.
- **Older phones**: built for Android System WebView 87+ (late 2020); older shows an "update needed" page (never a blank screen);
  no CSS :has(). Phone check before a release: Android 9 (WebView 69 → update page), 14 and 16; 16 KB check on every APK; a
  phone-check issue now fails the run (it always ended green before).
- **Security agent + free scan (13 Nov)**: `.github/scripts/security-scan.sh` (npm audit, gitleaks over all history, mobsfscan,
  semgrep OWASP rules, Android settings) — GitHub "Security scan" every Monday, on push to main, and by hand; accepted findings with
  reasons and review dates in `.github/security-accepted.txt`. Fixed: login-signing secret must be ≥32 characters and the public dev
  secret only runs under NODE_ENV=development/test; security headers on every server reply. Next security round (owner's yes):
  replace xlsx 0.18.5 with SheetJS 0.20.3 (by 31 Dec), login token in Android secure storage, shrink/obfuscate the release APK (R8).
  Paid outside test (₹1.5–2.5 lakh, CERT-In approved, retest included) once, after the dashboards, before selling widely.
- Plan locked: Hostinger KVM 2 → website → our control panel → distributor dashboard → company dashboard; ERP integrations later.

## Part 2 build log (developer, 14 Nov 2026)
- Part 1 follow-ups: "orders to approve"/"needs ok"/"approvals" answer in place (new + needs-OK table, Open button; "approve" still opens
  the screen); "aprove"/"loadsheet" typos; unknown role hides owner-only files; file kind tagged at the source; forgetSession() on every
  way out (offline too long, access removed, kicked). Test: app/tests/part1-followups.test.ts.
- 2a0 line numbers: OrderLine/picked `line` (stable 1,2,3…, ChangeSet numbers every order saved), shortage/excess `line` = bill line
  index; core/lines.ts (lineOf, pickedLines, shortageLines); server keepLineNumbers. Old records work unchanged. Tests: app line-numbers, server line-numbers.
- 2a: Sales reports tile (Home + Menu Sales); vans = core/vans.ts + ui/Vans.tsx (add/edit, Cases per trip, Kind chips, delete or hide,
  blocked while a trip is open or bills wait, unique numbers also a guard, hidden vans out of every picker). Tests: vans, part2-order.
- 2b Orders received: list of order cards → stacked line cards (Qty/Rate/Disc %, Ordered N note, add with last-5 chips, activity on
  the order), Approve one tap + Undo (core/orderEdit.ts), Excel + Bill reports in the header; Disc % 0–100 guard (phone + server);
  TESRAX download/open/approve order (core/tesraxOrders.ts). Tests: orders-received, part2-tesrax; e2e flow edits + approves.
- 2c Verify picked (core/verify.ts, ui/Approve.tsx): Ordered/Picked per line (Picked first, defaults to Ordered), Verify all, red short /
  amber extra, Rate + Disc % editable, Make bill blocked with the reason (stock); godown view hides rates (no godown tile yet). Test: verify-picked.
- 2d Disc % per line (₹ legal, discountPct kept) + the same product twice on sales bills (Settings.sameProductTwice, missing = on):
  priceLines/makeInvoices free once on line 1, stock out once (new bill moves id mv:{bill}:{lot}), shortages/credits per line, Delivery per
  line, hsnSummary from lines, company orders refused (phone + server). Chaos adds duplicate lines + "free twice" law (12×1000 green).
  Tests: same-product-twice (GST worked example ₹1,652 / HSN 15→17), part2-tesrax (Disc % by voice).
- Fixes G1 security: server orderRule/orderRates (staff phones: own orders only, salesman new-only edits/cancel, godown → picked only,
  product rate (lower only with rateRemark), no Disc %), rep orders own-only on push, repeated line numbers, Disc % before the no-qty skip,
  van numbers unique on the server, movement cap 1,000,000; sync replies `reasons` shown in the held message. Order `activity` is an
  append-only edit trail (stored entries must stay a prefix, new entries stamped with the token user) — NOT a hash chain. Tests: server safety §10.
- Fixes G2 stock: company-bill differences attach to lines (Diff.line, else the product's lines in order; each line checked against its
  own qty + free) — 2×10 with 4 short now stocks 16; each line its own lot (blank batch = bill no.), purchase lines name their lot
  (batchId) and P&L costs by lot first (lotCostRates); typed purchases refuse only a true double (product+batch+expiry+rate). Test: part2-stock-lines.
- Fixes G3 GST & money: scheme claim = min(scheme, discount actually given; free = min(scheme free, free given)); splitShort works free
  pieces on the product's combined qty (otherQty); GSTR-1 HSN key HSN+UQC+rate with the product's unit (uqcLabel, e.g. KGS-KILOGRAMS),
  e-invoice Unit from the product; dues keep every paisa (ledger OWED = 0.005, every screen/TESRAX/owner card; statement patch line
  removed). NOT built: the explicit write-off/round-off entry at collection — needs a data-model decision. Test: part2-money-fixes.

## Waiting for the owner
- **Rule (owner, 14 Nov): work only through the AI team** (CLAUDE.md, "Work only through the team"). Part 1 was built by the
  main session; ui-designer, security-operations and tesrax-language-specialist reviews of Part 1 were started 14 Nov evening.
- **Correction round Part 1 (look & TESRAX) BUILT and pushed on the founder's word (14 Nov, "directly push") before the full gate
  finished** — check the gate result for this push first; fix anything red before Part 2. Done: sphere 88 px with TESRAX inside the
  disc (approved mock v5), bar on every screen incl. TESRAX, opening screen same sphere; Home = 6 modules (Sales, Bill, Delivery,
  Accountant [Collection, GST, Day close inside], Stock, Payroll), no Search, owner card = Sales this month (net before GST, after
  credit notes) + Outstanding (active shops) via core/ownerCard.ts; Menu = group cards + gold Business Boost; type scale 11/12/14/16/20/26
  (--f1..--f6, 1rem = 14 px); TESRAX never jumps (Open button), Excel/PDF on every table, My files + chat history by day (30 days,
  per person, phone only — core/myfiles.ts, not synced), Clear chat. Tester: 2 majors fixed with tests (owner-card.test.ts);
  open: screen-type answers (P&L, Orders received) leave no file — planned with item 46 (Reports card, Part 4).
- **Part 1 review fixes (14 Nov evening, developer):** company e2e (Menu chip selector), TESRAX (Stock module, "collection module" →
  Accountant, needs-OK / load sheet answered in place), security (backup leaves out chats/My files, wipe/erase/new Privacy button
  clear them, daily 30-day purge, owner-only files hidden by role, no shared "nobody" bucket), CI (Trivy v0.36.0, npm ci before SBOM,
  age on the CI server job — issues #10/#11), look (white TESRAX panel — no ghost smudges, full firm name on 2 lines, no stripe on the
  owner card). **Owner decisions (14 Nov 18:57, built):** logging out deletes that person's chats and My files from the phone; My
  files expire after 30 days like chats.
- **NEXT (owner, 14 Nov): the CORRECTION ROUND — 47 items in 5 parts, locked in `docs/HANUBIX_CORRECTIONS_LOCKED.md`** (from the
  founder's handwritten review + chat). It REPLACES the 4-part convenience round below. Start with Part 1 (look and TESRAX): first
  show the Menu mock and the font-size screenshots, get his yes, then build. Each part: build → quick tests → tester → push → GitHub's full gate (no local full gate, owner 14 Nov) → real phone
  screenshots → his yes → next part. Also fold in the minor wipe-race fix and the open CI cards #10 and #11.
- Owner decisions 14 Nov (not app work): skip n8n (GitHub cards + scheduled tasks + server scripts + Postiz cover it); Postiz
  self-hosted on the Hostinger server later (free); iOS app only after the Android pilot and a customer asks (~₹8,700/yr Apple fee,
  ~2 weeks: Capacitor iOS shell + Swift versions of SecurePlugin and PrintPlugin).
- (Superseded by the correction round) **NEXT (owner, 13 Nov): move Hanubix into a claude.ai Project, then the convenience round in 4 parts.**
  1. **Project "Hanubix"** (owner creates it in the Claude app; instructions text and file list were given in chat on 13 Nov):
     instructions = CLAUDE.md rules in short; knowledge = this file, CLAUDE.md, QUALITY.md, HANUBIX_PLAN_LOCKED.md,
     HANUBIX_LOCKED_SIGNATURE.md, HANUBIX_SECURITY_STANDARD.md. Re-upload this file whenever it changes.
     Way of working: one **Head-office chat** (short; the owner's words become GitHub cards) + **one new work chat per part**
     (closed when the part is done). Departments talk through **GitHub Issues cards** (label per department + status: to do /
     in progress / waiting for Vishnu / done), never chat to chat. Departments that run alone are added one at a time as
     scheduled tasks, only when they have steady work (e.g. weekly TESRAX check, Marketing).
  2. **Card board — DONE (13 Nov).** Labels in `.github/labels.json` (one `dept: …` per department incl. opportunities-partnerships,
     + `status: to do / in progress / waiting for Vishnu / done`); pushing a change to that file creates/updates them (workflow
     `labels.yml`). Card template `.github/ISSUE_TEMPLATE/card.md`. Cards for Parts 1–4 are GitHub issues (see the Issues tab).
     How it works: a card carries one `dept:` label (who has it now) and one `status:` label; a department finishes, comments,
     swaps to the next `dept:` label. No GitHub Project board (labels filtered = the columns).
     Also opened: #10 (Security checks red: trivy-action@0.28.0 not found) and #11 (CI server deploy test red on the runner, SBOM
     step without npm ci) — both were red before the board, found on the first pull request into apk (#5).
  3. **Convenience round, 4 parts** (each: build → tester → one full gate → real phone screenshots → owner's yes → next part):
     - Part 1 Owner/office Home (medium): "Do this next" list, today's sales, owner alerts, Bill all approved, reject reason +
       approve undo, tappable day-close checklist; plus the minor wipe race fix.
     - Part 2 Salesman (medium): repeat last order, WhatsApp/Collect on every shop, route-ordered collection, short New shop,
       beat on a map, next job opens after save.
     - Part 3 Search and TESRAX (small–medium): search everywhere, TESRAX "bill <shop>" + typo help ("biscut", "box"),
       reports in one place.
     - Part 4 Driver, godown, company (small–medium): driver no-trip page, offline "will send" note, signed-bill photo,
       company rows tappable, Team today call/remind.
- **"Set up the team"** — ~30 new agents in 8 departments (Product, TESRAX quality, Security, Reliability and cost, Growth, Customers,
  Money and compliance, Founder's office); rule: nothing goes out without the founder's yes; watchers as plain scripts on the server;
  cheap models for routine work; chief of staff daily list + Monday review as scheduled tasks.
- **"Set up the departments"** (proposed 12 Nov, waiting): one Head-office chat for the owner (chief of staff turns his words into task
  cards); a shared task board = GitHub Issues in the repo, one label per department + status; each department a scheduled task that
  wakes (Product daily + "urgent", TESRAX quality/Security weekly, Customers daily, Growth 3×/week, Money weekly + 1st of month,
  Founder's office every morning; Reliability/cost as plain scripts on the server), works its cards and moves each to the next
  department; anything needing the owner goes to "Waiting for Vishnu" and his morning list. Build together with "Set up the team".
  **Plus a 9th department, Marketing** (owner, 12 Nov): Brand keeper (locked look and voice everywhere), Social media manager (weekly
  calendar for YouTube/Instagram/Facebook/LinkedIn; titles, descriptions, tags, real hashtags only, the owner's shock-style format),
  Video producer (HTML demo and comparison videos: script → style → low-res preview → 4K, each with his yes), Campaign planner
  (launch, festival/season, distributor meets, trade fairs), WhatsApp campaign writer, Ads manager (small Google/Meta tests, only the
  approved budget), Marketing analyst (what worked, cost per lead, in the Monday review). Nothing posted, sent or spent without his yes.
  **Timing (owner, 12 Nov): corrections and the convenience round FIRST; set up the departments when the app is ready for the first
  pilot distributor** (the video producer may start earlier on "Start the demo videos").
- **"Update both"** — the two decks (Company Deck https://claude.ai/artifact/7ToDDDs9dSb75NwMmhU8jH and Work and Hours
  https://claude.ai/artifact/7aFqUVaVQKVgnmk11uQZ2j): Montserrat + new logo, today's plan, new features; no price/market changes
  without showing the owner.
- **"Release"** — merge `apk` into `main` after the owner checks the latest APK on his phone (run chaos + sign-offs first).
- **"Make public link"** — optional: a public download page for test APKs (needs his yes; GitHub build files need a sign-in).
- Owner to do: buy Hostinger KVM 2 (24 months, India or Singapore data centre) and the domain; send the server IP and login;
  create the Google Maps key and add it as the MAPS_API_KEY secret.

## Latest APK
Look it up, never trust a link here: newest successful "APK" run on apk → its artifact
(https://github.com/Vishnupriyen/Hanubix/actions/runs/<run>/artifacts/<id>, sign in to GitHub first). Last one sent to the owner
(13 Nov, header change 95d06f7): runs/43360278695/artifacts/14007403468. The security round push (b2fd1e9) builds a newer one.
