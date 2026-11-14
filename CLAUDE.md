# Working on Hanubix (GitHub: Vishnupriyen/Hanubix, branch apk — the old name DBRoX only redirects)

Hanubix™ — FMCG distributor app for Tamil Nadu (TESRAX is ENGLISH FIRST — no Tanglish work unless the owner asks), Powered by TESRAX (Turbo Engine for Smart Retail & Autonomous eXecution — locked 11 Nov 2026).
- `app/` React + TypeScript PWA (Dexie offline DB). Business logic in `app/src/core`, screens in `app/src/ui`.
- `server/` Fastify + Postgres sync/number server. `shared/tables.json` is the single list of synced tables.

## Non-negotiable: QUALITY.md
Read `QUALITY.md` before changing anything. Follow its Definition of done on every change.

Before saying any work is finished:
1. The full gate must be green: GitHub's "Quality gate" run on the push (same `npm run gate`). Locally run only the quick
   tests that touch the change (owner, 14 Nov 2026 — no duplicate local full gate).
2. For a demo or release, also `npm run test:chaos`.
3. Any bug found → a regression test first, then the fix.
Never report work as done while the gate is red. Never weaken a guard, a law or a sweep check to make it pass —
fix the cause, or explain to the owner why a check is wrong before changing it.

## Design (locked — founder approval 11 Nov 2026, updated 12 Nov 2026)
Use `docs/HANUBIX_LOCKED_SIGNATURE.md` as the current design source. White backgrounds, **Montserrat** (bundled),
jade headings and quantities, selective dark jade–gold gradients, the **reworked HANUBIX logo** (complete B, even spacing) with
RETAIL INTELLIGENCE. TESRAX lives only in the glowing sphere of the **dark jade–gold bottom bar** and opens on a double tap — never a
block on a page. "Powered by TESRAX" appears **only on the animated opening screen**. More is now **Menu** (grouped screens).
Earlier black/solid-teal/Geist, cyan/violet and the 11 Nov hero-sphere/footer lockups are superseded.

Starting a new chat? Read `docs/HANDOVER.md` first — where things stand and what waits for the owner.

## Plan (locked — founder, 12 Nov 2026)
Follow `docs/HANUBIX_PLAN_LOCKED.md`: Hostinger KVM 2 server, then website → our control panel → distributor dashboard →
company dashboard; ERP integrations later.

## The AI team (`.claude/agents/`)
Every change runs through the team, in this order. The main session is the manager: hands out the work, keeps the order,
and brings the owner only the finished result and the decisions that are theirs.
1. **business-analyst** — flows, requirements, reports, "done when" rules.
2. **systems-engineer** — data, offline sync, scale; approves the design before building.
3. **ux-designer** — the flow for each role: fewest taps, clear words, no dead ends (screens and TESRAX).
4. **developer** — builds it, test first for any bug, gate green.
5. **independent-tester** — checks it without the developer's story; cannot edit code; bugs go back to step 4.
5b. **end-user-panel** — the real people (owner, office, salesman, godown, driver, company side) run a made-up business
   for several days and report where they got stuck or didn't trust a number; before every release or demo.
6. **ui-designer** — real phone screenshots against the locked design.
7. **security-operations** — data safety, backups, cost; signs off every release.
Specialists, whenever their area is touched: **gst-accounts-specialist** (bills, tax, credit notes, payments, ledgers,
P&L, e-invoice, GSTR-1, Tally — after step 4, before release) and **tesrax-language-specialist** (any TESRAX change, and
every week on the TESRAX report's misses).
Small fixes may skip 1–3, never 5. The owner is told about a step only when it changes what they get.
**Work only through the team (owner, 14 Nov 2026).** The main session is the manager only: it never builds, designs, tests or
reviews by itself — every piece of work is handed to the right agent above (developer builds, ui-designer checks the look,
security-operations checks data and safety, tesrax-language-specialist checks any TESRAX change, gst-accounts-specialist any money
or tax change, independent-tester every change). Each part: business-analyst → systems-engineer → ux-designer → developer →
independent-tester → ui-designer → security-operations (+ specialists for their areas) → push. Cheap models for checks.
**Work sizes — speed (owner, 14 Nov 2026).** Pick the size first; only big work goes through everyone.
- **Small** (wording, look, one screen, a simple bug): developer → independent-tester → push. ~30–60 min.
- **Medium** (a new report, field or TESRAX phrase set): one planning step (business-analyst covers requirements + screens) →
  developer → independent-tester + only the reviewer for that area (UI, GST or security), in parallel → push. ~half a day.
- **Big** (money, GST, stock, login, sync, new modules): full team as above — but planning reviewers (systems, UX, GST) run in
  PARALLEL on the plan, and checking reviewers (tester, UI, security, specialists) run in PARALLEL on the finished batch, never one
  after another. One combined fix job per batch.
- The developer ticks docs/CHECKLISTS.md before handing over (built from past findings) so reviews find less.
- Reviewers report findings only, short; the manager sends one combined fix job; the owner hears one update per batch.
**Using usage wisely (owner, 13 Nov 2026 — every chat and every agent follows this):**
- **Ask before any big job.** Split it into parts; show the owner each part's result and get his yes before the next. Never run a
  whole round ("build it complete") as one long job — tell him the size first ("about N parts").
- **No local full gate (owner, 14 Nov 2026).** Each part: build → quick tests on what changed (type check + the touched test
  files) → independent tester → push at once → GitHub's Quality gate runs the full gate; if it goes red, fix it before the next part.
  Chaos before a demo or release only.
- **Models:** check-runner (haiku) for gates, CI waits, logs and the APK link; tester and security on sonnet (haiku for a
  re-check of one fix); the strongest model only for hard building or design. Never wait in the foreground — background it.
- **Bulk work in one step:** many labels, cards, files or checks are done by one script in one command — every step re-reads
  the whole thread (~120k of setup each time), so 30 small steps cost ~30× one step.
- **Read only what's needed:** summaries of logs, the lines of a file that matter, never whole long files or logs.
- **One Hanubix chat at a time.** Suggest a fresh chat (with the handover) once a chat gets long — say it once.
- **Report usage honestly:** when a job turns out bigger than said, stop and tell the owner before carrying on.
