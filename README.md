# Havilah Inventory

Mobile-first inventory & bar sales app for Havilah Suite Ltd (Awka & Nnewi).
Shares the Supabase project with the front desk register: same staff, same
branches, one stock ledger.

## Setup

1. Run `10_auth_rls.sql` in the Supabase SQL Editor (once).
2. Create logins: Supabase Dashboard → Authentication → Add user
   (email + password; emails like `chidi.openbar@havilah.local` are fine).
3. Link each login to its staff row — template at the bottom of `10_auth_rls.sql`
   (sets `auth_user_id` and the barman's `default_location_id`).
4. `cp .env.example .env` and fill in the project URL + anon key
   (Dashboard → Settings → API).
5. `npm install && npm run dev`

## Deploy (Netlify)

Push to GitHub → import in Netlify → add the two `VITE_` environment
variables → deploy. `netlify.toml` handles the SPA redirect.

## How it behaves

- Barman signs in, lands on Sales with their bar preselected.
- "Record a sale": search item (most-sold first, live stock shown),
  qty stepper, tier + payment chips, optional split; price is editable
  because real prices sometimes deviate from catalog.
- PR / damaged are write-offs (stock_movements), never sales rows.
- Every saved sale writes its own stock deduction via the DB trigger —
  the app never computes stock, it only reads `v_stock_on_hand`.
- Stock tab: on-hand by location, negatives in red (they mean a count
  or a missed entry is needed).
- Store tab (storekeeper / manager / gm / admin only): Receive records
  deliveries into the store with unit cost; Disburse moves stock from
  the store to a department. Several items are staged and saved in one
  go, and Disburse warns when a line exceeds what the store holds.

- Fix tab (manager / gm / admin only): last 14 days of sales and stock
  movements, each editable (quantity, price/cost) or deletable. Deleting
  a sale reverses its stock deduction automatically; editing one restates
  its payment record to the new total. Sale deductions are hidden from
  the list — correct the sale itself and the movement follows.
  A second view, Change history, shows every deletion and edit with
  who did it and when. That log is written by database triggers
  (15_audit_log.sql), so corrections made outside the app are recorded
  too. It is append-only: nobody can edit or delete the log itself.
  Storekeepers have the same Fix tab as managers (18_storekeeper_full_rights.sql).

## Branch scope

Only GM and admin see both branches (21_branch_scope.sql). They get a
branch selector in the header; switching reloads the whole app against
that branch, so every screen — sales, stock, credit, counts, corrections
— shows the selected branch. They can also record in either branch
(26_admin_cross_branch_write.sql). Everyone else has no selector and is
pinned to their own branch by RLS regardless of what the client asks for. Managers,
store managers, auditors and bar staff are confined to their own branch —
they keep every capability their role carries, but only within it.
Someone who works both branches needs one account per branch.

- Credit tab: outstanding balances per customer, a full statement
  (credit taken, payments received, balance) and Record payment for
  recovery by POS/cash/transfer. Print / PDF uses the browser's print
  dialog — "Save as PDF" produces the invoice.
- Count tab: the store manager starts a count for a location, enters
  physical quantities against what the system says, and submits it.
  An auditor then verifies, and any variance posts automatically as
  an adjustment so the ledger matches the shelf. Only an auditor can
  verify — enforced by verify_stock_count(), not the UI.

## Kitchen, Housekeeping and Others

These are consuming departments (`consumes_on_issue`). Stock disbursed
to them is expensed on issue: it leaves the store and does not build up
as a balance there. Consumption stays attributed to the department for
reporting via `v_consumption`. They are not sales points, so they never
appear on the Sales screen — kitchen staff can be given their own sales
point later by flipping `is_sales_point`.

## Who sees what

`staff_locations` assigns each person their departments (14_staff_locations.sql).
Barmen see only their own areas on both the Sales and Stock tabs.
Storekeepers, managers, GM and admin see every location — as does
anyone with no assignment yet, so nobody is locked out by omission.

At Nnewi, OpenBar staff are assigned OpenBar *and* Lounge, since
Lounge is a location there. At Awka, Lounge is a price tier, so
OpenBar staff reach it through the tier chips instead.

## Who can do what

Location is never locked: `default_location_id` only preselects a
staff member's usual bar, and anyone can switch. Awka's OpenBar staff
ring up Lounge-priced sales via the tier chips on the same screen.
Recording is open to all active staff for their own branch; editing
and deleting history stay manager-only (enforced by RLS, not the UI).


## Offline behaviour

Writes that fail because the connection dropped are kept in
localStorage and retried automatically when it returns (`src/lib/outbox.js`).
A banner shows how many entries are waiting. Only connection errors are
queued — a real rejection (bad data, a permission error) surfaces to the
user immediately instead of being silently swallowed.

## Sales are recorded as a basket

Add several items, adjust tier and price per line, then take payment once.
The payment split is allocated across the lines automatically. Overdrawing
a location asks for confirmation rather than blocking.

## Backups

See BACKUP.md.


## Sales reporting model (change request section 4)

Gross Sales and money collected are separate figures and are never
summed together:

    Gross Sales      = sum(qty x unit price)      -- goods off the shelf
    Received at sale = POS + Cash on those sales
    Credit raised    = Gross Sales - Received     -- derived, not typed
    Debt recovered   = repayments received today against earlier credit
    Total money in   = Received + Debt recovered

Debt recovery never increases Gross Sales. The panel on the Sales
screen shows all five, per location per day, for checking against the
Book of Records. Views: `v_reconciliation`, `v_debt_recovered_daily`.

## Backdating

The date on a sale defaults to today. Bar staff can post up to 4 days
back; store manager, manager, GM and admin reach the opening-balance
date (31_staff_backdate_window.sql). Future dates are refused for
everyone. All three rules live in `validate_sale_date()`, not the UI —
change `window_days` there to adjust the staff window.

Note the interaction with corrections: bar staff can only edit their own
entries from today and yesterday, so a sale they backdate further than
that cannot afterwards be corrected by them — it needs a store manager. Backdated rows carry an optional reason
and show a "backdated" marker. All reporting keys off `business_date`.

## Opening balances

More > Stock count > Opening balance: pick a location and date, enter
counted quantities, post. Writes adjustment movements for
(counted - system) and sets the branch's opening-balance date, which
then bounds backdating. Manager-only, and deliberately skips the
auditor step — every such posting is written to the audit log saying so.

## Variances

More > Variances lists any sale where POS + Cash + Credit does not equal
quantity x unit price, with operator and amount (`v_sale_variances`).
Bar staff cannot save an unbalanced sale at all; managers can override
with a confirmation, and the override lands here.


## One customer, one record

Customer names are normalised in the database (`normalize_customer_name`):
titles, bracketed asides, "c/o ..." attributions and punctuation are
stripped, so "Mr Chike", "Mr. Chike", "Mr Chike c/o Kelvin" and
"Mr Chike (Caleb)" all reduce to the key `chike`. A unique index on
(branch_id, name_key) means a second record cannot be created for the
same person, and the app reuses the existing one if a barman types a
different spelling.

Who served the customer goes in `served_by`, not in the name.
`v_customer_similar` lists near-matches the key cannot catch (a surname
added later, a typo); `merge_customers(keep, merge[])` folds them
together, moving sales and repayments to the surviving record.

Catalog editing is GM and admin only, enforced by RLS.


## Receipts

Every basket is stamped with a `receipt_id`, so its lines can be pulled
back together and printed as one document however it was paid — POS,
cash, credit or a split. The receipt shows department, item, tier, qty,
unit price and amount, then a payment table naming each method and its
amount; a credit portion is labelled as outstanding. Customer is optional
on cash and POS sales (blank prints as "Walk-in") and required for credit.

Reprint from the Sales screen: tap any row under Today, or use "Receipt
for the last sale" straight after saving. `27_receipts.sql` also groups
existing app-entered sales into receipts so older sales can be printed.


## Credit is per department

OpenBar's debtors are not MainBar's. A customer is still one record
(so a name is never split in two), but credit taken and repayments are
tracked per location: `v_customer_balances_by_location`, and
`credit_repayments.location_id`. The Credit tab has department chips,
each showing only what is owed to that department, and a statement
prints with the department in its header.

A repayment always belongs to the department whose credit it settles —
paying at OpenBar does not clear a MainBar debt.

## Staff fixing their own mistakes

Bar staff get More > Corrections showing only entries they themselves
recorded, from today and yesterday. They can edit quantity, price and
payment split — they cannot delete anything (29_staff_no_delete.sql).
Removing a record is store manager, manager, GM or admin only. The edit
window is enforced by `app_owns_recent()` in RLS, so it cannot be
widened from the client. They cannot see the change
history, and anything they alter is written to it under their name.
Backdating remains editor-only.


## Records are private to the person who recorded them

Bar staff see only their own sales and only the credit owed to them
(32_per_staff_records.sql). Joseph cannot see Ikenna's debtors even
though both work Open Bar. Store manager, manager, GM and admin see
everything for the branch and can filter the Credit tab by person.

Customer NAMES remain readable branch-wide — without that, a second
staff member typing an existing customer would hit the unique index and
the sale would fail. Names are shared; balances and statements are not.

`credit_repayments.credit_staff_id` records whose ledger a payment
settles, which is not always who collected it: a store manager taking
money for Joseph's debtor credits Joseph's ledger.

## Price tiers

The tier buttons sit above "+ Sell Item" — Standard / Lounge / Staff at
Awka, Standard / Lounge at Nnewi, driven by `branch_price_tiers`. Pick
the tier first and everything added is priced at it; switching mid-basket
reprices what is already there. A single line can still be overridden by
tapping it. The tier resets to Standard after each sale so the next
customer is not mispriced, and non-standard tiers are shown in amber on
the basket line and on the receipt.


## Bug fixes (round 2 audit)

- Write-offs (PR, damage) are now editor-only both in the UI and in
  RLS (34_writeoff_lockdown.sql) — a bar account cannot post one even
  through the API. The old always-visible "PR/damage" shortcut inside
  the item picker is removed; the single gated button above Sell Item
  is now the only entry point.
- PR/damage on the Sales panel is scoped to the department being
  viewed, same as every other figure there (`v_daily_non_revenue`
  gained `location_id`).
- Switching the basket's price tier no longer overwrites a line whose
  price was hand-edited; those lines carry `priceOverridden` and can be
  reset back to the tier price explicitly.
- A write-off now has its own date field (defaults to the sale date)
  instead of silently inheriting whatever the basket was set to.
- The receipt and the credit statement no longer share a print target
  id — each prints independently even if both could ever be open.


## Verification pass fixes

Checking every requirement against the deployed source turned up bugs
the earlier rounds missed:

- **The repayment/debt-recovery bug was still live in the app**, despite
  the database fix in 33. The "Record payment" button never attached a
  department or staff to the payment (`location_id` was always saved as
  null), so a saved payment could never match the department-filtered
  balance it was meant to reduce — the debt kept showing as unpaid. Fixed
  in `Credit.jsx`; also fixed the payment sheet showing "Owing ₦0" on
  every payment regardless of the real balance, for the same reason.
- PR/damage on the Sales panel was still branch-wide because the query
  fetched the old column shape after `v_daily_non_revenue` gained
  `location_id` — it was never updated to request or filter on it.
- Sales recorded "on behalf of" a staff member reached their credit
  ledger (via the balance view) but not their own Corrections list or
  an individually-opened ledger, because those two raw queries matched
  only `recorded_by`, never `on_behalf_of`. Fixed to match either.
- Since on-behalf-of sales now appear on the recipient's own list, the
  Edit button is hidden on entries they did not personally type — RLS
  only lets the actual recorder amend a sale, so showing an Edit button
  there would have failed silently. A note explains why instead.


## Fresh-start scoping (round 3 audit)

- Variances now respect a branch's `opening_balance_date` at the
  database level (`v_sale_variances`, 38_variances_respect_opening_date.sql)
  — the same rule backdating already followed. Nothing is deleted;
  pre-reset variances simply stop being reported once a branch has
  moved past them with a fresh start. Applies to any branch that ever
  gets reset this way, not just today's.
- The customer-name normalizer existed as two separate JS copies, and
  both had drifted out of sync with the database function after an
  earlier live update (added "doctor", "oga", "aunty", and others).
  One copy only weakened a UI hint; the other sat in the
  duplicate-conflict recovery path in `createCustomer` — a mismatch
  there could make the recovery miss the existing customer and surface
  a raw database error mid-sale instead of quietly reusing the right
  record. Unified into `src/lib/customerName.js`, one function, used
  everywhere, so this can't drift again.
- Removed a dead, unused `startCount` function left over from an
  earlier round.


## Final sweep (round 4)

- **Silent count-line save failures, now fixed.** A dropped connection
  while entering a stock count updated the number on screen but failed
  the actual save with only a `console.error` — no toast, nothing to
  tell the person their entry hadn't landed. A count could be submitted
  looking complete while some lines were silently still null, producing
  wrong variance postings with no warning. Count-line saves now surface
  a clear error, or queue through the offline outbox and retry
  automatically — same mechanism already proven for sales.
- **Credit repayments now go through the offline outbox too** — the same
  real-world conditions as a sale (weak signal at the counter) could
  previously fail a payment with no retry.
- **Fixed a timezone bug in "own recent entries."** The bar-staff
  edit window was computed from raw UTC time instead of the Lagos
  business date, so near midnight it could show a third day of entries
  whose Edit button would predictably fail against the database's
  correctly-timezoned boundary. Both now compute the same way
  (`lagosDaysAgo()`), and the Edit button itself checks the date, not
  just who recorded the entry, so it never appears where it can't work.
- Confirmed clean: no dangling references to removed features (the old
  picker write-off shortcut, the shared print-target id), all six roles
  consistently gated across every screen, and the auditor's two-tab
  view (Stock, Count only) holds together correctly end to end.
- **Known, deliberate gap:** the 4-day staff backdating limit is a
  constant in both the database function and the React component
  (`STAFF_BACKDATE_DAYS`). The database is the real enforcement, so a
  mismatch could only ever show the wrong number in the UI, never
  permit an out-of-bounds post — left as two constants rather than
  adding a settings lookup for one cosmetic value, but worth knowing
  if that limit is ever changed.


## On-behalf-of is now location-scoped

The "recording on behalf of" list on the Sales screen now shows only
staff assigned to the currently-selected location — Open Bar shows its
own people, MainBar its own, Minimart its own — instead of every bar
hand at the branch. It also includes front desk staff, who record
Minimart sales (see below). Switching locations reloads the list and
drops a stale selection if that person doesn't work the new location.

Front desk staff can now record sales here (39_front_desk_minimart.sql)
— same rights as bar staff: record for their assigned location, edit
their own entries today/yesterday, never delete. This is new capability
inside the inventory app only; nothing about their innflow access changes.

**One thing to decide, not assumed:** the two existing Front Desk
accounts are shared logins (one per branch, from the original
migration). Daniel/Mercy and Princess/Chidimma could share those, or
each get an individual login — the file includes both paths. Individual
logins match how every other credit/sales attribution in this app
works (`recorded_by`, `credit_staff_id`), so that's the recommended one
unless there's a reason to keep it shared.


## Catalog: full visibility and safe delete

The Catalog screen now fetches all items — active and inactive — for
itself (`loadAllCatalogItems`), separate from `boot.items` (which stays
active-only everywhere else, so pickers are unaffected). Active /
Inactive / All filter chips let an admin find and reactivate something
previously deactivated, which was impossible before.

Delete is real but guarded: `delete_stock_item()` (43_catalog_delete.sql)
refuses to remove anything with a single sale, movement, or count line
against it, anywhere, ever — the error names exactly how many of each it
found. Only a genuinely unused item (created by mistake, or a stray
duplicate never actually transacted against) can be hard-deleted.
Everything else stays on the "deactivate" path that already existed,
which hides an item everywhere without touching its history.


## Search and department filter on Corrections

The Corrections screen now has a search box (item name, department, or
a date in YYYY-MM-DD) and, on the Entries view, department chips —
matching the same pattern used on Sales and Store. Department is
resolved per entry regardless of type: a sale's own location, or a
movement's destination (falling back to its source for things leaving
a location, like an issue or disbursement).

Search also works on Change History, matching against the stored
summary text and date, since that view has no structured location
field of its own — the summary text already names the department, so
a search for "MainBar" still finds it.


## Deleting a customer

GM and admin only see a "Delete customer" button on a customer's
statement — narrower than the general edit right on the Credit page,
which also covers storekeepers. Same safety rule as catalog items:
`delete_customer()` (46_credit_customer_delete.sql) refuses to remove
anyone with a single sale or repayment against them, ever, and names
the counts in its error. The confirmation dialog offers "Deactivate
instead" right there for that common case — it hides the customer from
future credit sales without touching their history, reusing the
existing `customers.is_active` flag.


## Issue history per department

Under "+ Issue To" on the Store screen (Issue/OUT mode), a collapsible
"History — <Department>" section shows everything issued to whichever
department is currently selected: item, quantity, date, who received
it, and who issued it. Switching the department chip switches the
history shown — it follows whichever department you've selected, same
as the item picker and receiver field do. Covers the last 60 days.
No database changes — reads the same `stock_movements` rows already
written by every issue.


## Structural sweep (round 5)

Cross-checked the entire app against every migration file rather than
a single feature:

- Every RPC the app calls (`submit_stock_count`, `post_opening_balance`,
  `verify_stock_count`, `delete_stock_item`, `delete_customer`) is
  defined exactly once, matching what's called.
- Every view and helper function the app or RLS depends on exists,
  and where one was redefined across rounds (e.g. `app_branch`,
  `v_reconciliation`), the later version is a proper superset —
  nothing that an earlier round relied on silently disappeared.
- Every RLS policy that was ever dropped was recreated at least as
  many times as it was dropped — no silent lockouts. Every table with
  RLS enabled has a working read policy.
- Every column the app writes to has a matching migration that
  created it — no client code pointing at a column that was never
  actually added.
- Removed two dead functions: `saveSale` (replaced by `saveBasket`
  when checkout became a basket, never deleted) and
  `loadReceiptsForDate` (built for a receipt-listing feature that
  ended up implemented a different way — tapping a row directly, or
  "receipt for the last sale" — and was never wired in). Zero
  behavior change; the build output was byte-identical, confirming
  neither was ever actually reachable.
- Added `MIGRATIONS.md` — with 47 files and several explicitly
  superseding earlier ones, there was no single answer to "which
  files do I actually run if I ever rebuild this." Now there is.


## Crash reported: "TypeError: n is not a function" while switching branches on Catalog

Root cause not conclusively identified from a minified stack trace
alone (no sourcemap in production, and the trace pointed into React's
internal scheduler rather than app code directly) — but two real gaps
were closed regardless of the exact cause:

- **No crash safety net existed anywhere.** Any unhandled error in any
  screen unmounted the whole app to a blank white screen with nothing
  but a console log — exactly what was reported. Added
  `ErrorBoundary` wrapping the whole app: a crash now shows a plain
  "Something went wrong — Reload" message instead of nothing.
- **Catalog didn't reset its own state on a branch switch.** Since the
  GM/admin branch selector re-renders the current screen with new data
  rather than remounting it, an open edit sheet, a delete confirmation,
  or a half-filled "add item" form could keep referencing the
  *previous* branch's item after switching. Catalog now explicitly
  clears all of that the moment `staff.branch_id` changes, so switching
  branches can never leave stale state behind to act on incorrectly.

If this recurs, the browser console's full stack trace (all frames,
via "Copy stack trace" in DevTools) would let it be pinned down
precisely — the pasted trace here was already truncated to minified
function names with no line mapping.


## Source maps enabled

`vite.config.js` now builds with `sourcemap: true`. Without this, any
production crash only ever showed minified names ("n is not a
function", "at el", "at ns") with no way to trace them back to real
source — which is why the branch-switch crash took multiple rounds to
even attempt to localize. With the map file deployed alongside the JS
bundle, the browser decodes a crash automatically: the same error will
show the real file and line number directly in DevTools, no extra step
needed to reproduce it.

The map is public (served as a plain file next to the JS), which is a
fine tradeoff here — there's nothing secret in the frontend source;
every real permission boundary is enforced server-side by RLS.


## The branch-switch crash: found and fixed

Root cause: `Catalog.jsx`'s data-refresh function was written as a
single-expression arrow with no braces —
`() => loadAllCatalogItems(...).then(setAll).catch(...)` — passed
directly as a `useEffect` callback. The value of that expression is a
**Promise** (`.catch()` always returns one), and React treats
whatever an effect returns as a cleanup function to invoke before the
next run. Switching branches is exactly what triggers that: Catalog
re-renders with a new `staff.branch_id`, React tries to run the
previous effect's "cleanup" before starting the new one, and calling
a Promise as if it were a function throws exactly the reported error.

Every other screen's refresh function was already written as a
braced block (implicitly returning `undefined`, which is what
`useEffect` expects) — Catalog was the only exception in the entire
app, which is exactly why it was the only screen that crashed. Fixed
by wrapping it in braces to match every other page; swept the rest of
the codebase for the same shape and found no other instances.

Getting here took several rounds of stack traces that all turned out
to be non-informative (minified names, then correctly-resolved but
unhelpful React-internals frames) — the crash happens inside React's
asynchronous effect scheduler, which is a context where the
JavaScript call stack genuinely does not preserve the original
calling code, no matter how good the source map is. The source maps
enabled earlier are still a permanent, valuable improvement for any
future crash that *does* originate in a normal render or event
handler, where they'll work as intended immediately.


## Front desk given Credit, Recovered Debt, and Corrections

The database side of this was already correct from when front desk
first got recording rights (39_front_desk_minimart.sql) — the RLS
policies check what someone did (`recorded_by`, `app_owns_recent()`)
or a general "can record" flag, not a hardcoded role list, so front
desk already had the right to use these three pages. The gap was
purely in the app: `front_desk` was missing from More.jsx's visibility
list for all three, and Corrections/Credit had their own internal
`role === 'bar'` checks that would have shown front desk a broken or
read-only view even after the menu item appeared. All three fixed —
front desk staff (Daniel, Mercy, and the rest) now get exactly the
same rights bar staff have: record, view their own department's
credit and recovery, edit their own entries from today and yesterday,
never delete. No database changes needed for this round.


## Sign-out confirmation

Tapping "Sign out" now asks first, since with one phone per person the
main real risk of losing a session is an accidental tap rather than
anything the app was doing wrong. The dialog also reminds people that
on their own phone, closing the app is usually enough — signing out
isn't needed day to day, since the session persists on its own
(Supabase's client keeps it in local storage automatically; this was
already true before this change, nothing new added there).

No credential storage was added, deliberately — the login form already
carries the right `autoComplete` attributes for the phone's own browser
password manager to offer to save and autofill, which is the safe
version of "remember my password" and requires no code in this app.


## Stock count, opened up to staff

Bar and front-desk staff can now count their own department's stock
at the end of a shift and submit it for the auditor — same flow as
storekeeper's counts, with two deliberate limits:

- **Own department only.** The location picker for staff uses their
  assigned location(s) (`boot.locations`), not the full branch list —
  a barman counts his own bar, not any department. Storekeeper and
  above still see every location, unchanged.
- **No "Opening balance" option.** That stays storekeeper/manager/gm/
  admin only — it's a structural reset, not an end-of-shift tally.
  Staff only ever create the ordinary "count" type, and the date is
  locked to today rather than backdatable.

Every count now shows who counted it and, once verified, who verified
it — pulled from the same `counted_by`/`verified_by` columns that
already existed, just not previously surfaced in the UI.

Staff may delete their own count only while it's still a draft
(nothing posted to stock yet, genuinely harmless); once submitted,
removing it requires storekeeper and above, same as before. Reading
is department-wide — anyone assigned to a location can see that
department's counts, whoever did them, same visibility rule already
used for sales and credit.

53_staff_stock_counts.sql carries all of this at the database level;
the app changes are cosmetic on top of policies that now actually
allow it.


## Loading performance

Two separate problems were making branch switches (and, more subtly,
every screen's normal refresh) slower than they needed to be:

- **The app was redoing identity work it didn't need to.** Every
  branch switch re-ran the full bootstrap — an auth check plus a
  staff-table lookup — even though the person's identity hadn't
  changed, only which branch they wanted to view. `loadBootstrap()`
  is now split into `loadStaffIdentity()` (runs once per sign-in) and
  `loadBranchData()` (the part that actually depends on which branch
  is selected). A branch switch now calls only the second half —
  two fewer network round trips before the real work even starts.
- **`v_stock_on_hand` had no supporting index.** This view backs
  almost every screen — Sales, Stock, Store, Counts — and
  `stock_movements` has grown into the largest table in the schema.
  Without an index matching its actual filter (branch + location,
  grouped by item), every read was a full table scan. Added two
  partial indexes matching exactly what the view queries
  (54_performance_indexes.sql), plus smaller ones for `stock_items`,
  `stock_counts`, and `customers` that were filtered by branch
  constantly but never indexed for it.

The identity/branch split is a real, measurable reduction in what
happens on every switch. The indexes should matter more as the two
branches' history keeps growing — the query pattern doesn't change,
but how expensive a table scan is does.


## Daily financials: four requests collapsed into one

`get_daily_financials()` (55_daily_financials_rpc.sql) computes gross
sales, received-at-sale, credit raised, debt recovered, the
payment-method breakdown, and PR/damage figures all in one database
function call — replacing `loadDailySummary` + `loadReconciliation`,
which together fired four separate queries (already concurrent with
each other, but still four round trips). One RPC now returns
everything Sales' reconciliation panel needs.

Runs as SECURITY INVOKER (the default, stated explicitly) — RLS on
sales, sale_payments, stock_movements, and credit_repayments applies
exactly as before, so a bar hand still only sees their own
department's numbers and a GM viewing the branch still sees the
branch total. Only the number of requests changed, not what anyone
is allowed to see.


## In-app alert for submitted counts

Auditor, storekeeper, manager, GM and admin now see a badge when one
or more counts are sitting in "submitted" — on the More tab itself (a
small number, noticed before even opening the menu) and again next to
"Stock count" inside it, with the hint text changing to "N awaiting
your verification".

This is an in-app alert, not a push notification — it updates while
the app is open (checked on load, on branch switch, and every 60
seconds) but won't buzz a phone whose screen is off. A true push
notification would need new infrastructure this app doesn't have yet
(a service worker, browser permission prompts, a server-side trigger
to fire the push) — a real, buildable feature, just a materially
bigger one than what was asked for here.

No database changes — `loadPendingVerifications()` is a lightweight
count-only query against `stock_counts`, and it inherits the same RLS
already governing that table, so each person only ever sees their own
branch's pending count.


## Count deletion narrowed to a specific role list

Deleting a stock count is now storekeeper, GM, auditor, and admin
only — an exact list, not "editor-tier" or "verifier-tier" reused.
Two deliberate consequences worth knowing:

- Plain "manager" role is excluded, even though it has most other
  editor-tier rights elsewhere in the app.
- Auditors gained delete rights they didn't have before (previously
  verify-only).
- The earlier rule letting bar/front-desk staff delete their own
  not-yet-submitted draft is gone — only the four listed roles can
  remove a count now, at any stage short of verified.

Verified counts remain permanently undeletable, unchanged.


## Stock count deletion: two separate rules now, not one

Fixed while implementing this: the app already had a
`CAN_DELETE_COUNT` list (storekeeper/manager/gm/auditor/admin) but it
was wired to allow deleting BOTH drafts and submitted counts with no
split — and along the way, the counting staff member's own right to
delete their own not-yet-submitted draft had been dropped entirely.

Now, matching 56_count_delete_rules.sql exactly:
- **Draft** — only the staff member currently counting it.
- **Submitted** — only storekeeper, manager, GM, auditor, admin. The
  auditor gaining delete rights here is new; previously they could
  verify a count but not remove one.
- **Verified** — nobody, unchanged.

Enforced at the database via `counts_remove`, not just hidden in the
UI — the app's button visibility now matches the RLS policy exactly.


## Cross-department stock movement and conversion

Store now has four modes: Receive, Issue, **Move Between Depts**, and
**Convert** — storekeeper/manager/gm/admin only, same as the rest of
Store.

**Move** transfers stock directly between two departments without
routing through the store — pick From, pick To, add items. Only makes
sense for items that are genuinely one catalog row stocked at
multiple locations (see the Gala/Peanut merge below).

**Convert** records one item becoming a different item at a fixed
ratio you type each time — e.g. 2 bottles of groundnut into 10
plates. Posts as two linked `conversion` movements (one deduction, one
addition) sharing the same note, so the pair reads as one event in
history. The ratio is entered per conversion, not stored as a
permanent recipe — simpler, and a wrong ratio can't silently apply
forever with nobody noticing.

Gala and Peanut 250g (Bottled) were each split into two catalog rows
per location — the same problem Gulder had. Merged into single items
(62b_merge_gala_peanut.sql) using the existing `merge_stock_items()`,
then renamed to drop the location suffix. Moving either between
OpenBar and Minimart is now an ordinary Move, nothing special.

## Corrections now shows who a sale belongs to

Any sale with a customer attached shows "customer: <name>" in its
detail line, and the search box matches on it — so before editing or
deleting an entry, it's clear whose record it actually is rather than
just an item and a price that could belong to any of several people.
Uses "customer", not "debtor" — a sale can have a name attached even
when paid in full cash, not only on credit.


## Auditor: Credit, Recovered Debt, Variances, and Daily Sales

The auditor already had RLS-level read access to sales, credit, and
variance data from early on — it was never actually exposed through
any screen. Added to More: Credit, Recovered Debt, Variances (all
read-only for this role; "Record payment" is explicitly hidden on
Credit for auditor, since the database already refuses to let an
auditor record anything and a visible button that fails on tap is
worse than no button).

## Daily Sales — new, shared page

A genuinely new capability: browse any past day's sales, filterable
by department, for auditor/storekeeper/manager/gm/admin. This is what
gives the auditor sales visibility at all (they have no live Sales
tab, by design — an auditor never records). No date floor other than
"not the future" — unlike the live Sales screen, this is pure viewing,
not backdating a write, so there's nothing to restrict.

## Department filter now actually filters the sales list too

On the live Sales tab, clicking a department chip already filtered
the reconciliation summary, but the list of individual sales below it
still showed every department mixed together — `loadToday()` never
had a location parameter to filter by. Fixed for everyone using that
screen, not just the new page.


## Sales lists show who recorded each entry

`loadToday()` now embeds the recording staff member's name (and, when
a sale was entered on someone's behalf, that person's name too) —
shared by the live Sales screen's "Today" list and the read-only
DailySales history, since both call the same function.

Display rule lives in one place (`whoRecorded()` in format.js) rather
than being written twice: shows the person the sale is attributed to
if it was recorded on someone's behalf, noting who actually entered
it — otherwise just whoever entered it themselves. One shared
definition so the two screens can't drift apart on this the way the
customer-name normalizer once did.


## Auditor's nav: Daily Sales promoted, before Stock

For the auditor specifically, Daily Sales is now a dedicated
bottom-nav tab — positioned before Stock — rather than something
reached two taps deep through More. Every other role still finds it
inside More as before; hidden from the auditor's own More list
specifically so it doesn't appear in two places at once, and the
More tab no longer falsely highlights as active while viewing it
through the dedicated tab.


## Recovered Debt now shows both dates

Each row shows "Credit taken [date] · recovered [date]" — and, when
the customer's credit at that department spans more than one purchase,
"(most recently [date])" too.

Worth knowing why this isn't tied to one exact transaction: a
repayment settles a customer's overall balance, not one specific
credit sale (`credit_repayments.sale_id` exists in the schema but the
app has never populated it — payments are recorded against the
balance as a whole, which is often correct since one payment can
cover several purchases at once). So "date of credit" here means when
that customer's debt at that department first began, not the date of
any single sale — the honest version given how repayments actually
work, and the same convention already used on the Credit page's own
"since" display (63_recovery_credit_dates.sql).


## Credit page: department chips now explicit, not inferred

The department chips on Credit were using the staff-scoped location
list. For storekeeper/manager/gm/admin this happened to equal every
department (they're excluded from location-scoping elsewhere), but
for auditor it only worked because auditors typically have no
`staff_locations` row — the "no assignment = sees everything"
fallback, not a guarantee. An auditor accidentally assigned to one
department would have silently lost visibility into every other
department's credits, with nothing to indicate why.

Fixed to check the role explicitly (`seesAllDepartments`) rather than
rely on that inference — management and audit roles always see every
department's chip regardless of any stray assignment. Confirmed the
underlying RLS (`app_is_auditor()`) already granted unconditional
branch-wide read access regardless of location, so the actual data was
never at risk — only which chips the auditor could click.

"Who recorded this credit" was already shown per row (`by <name>`)
for every role, no change needed there.


## Payment method shown on Sales and Daily Sales lists

Every entry now shows its payment method — POS, Cash, Credit, or
"Split: POS + Cash" when a sale was paid across more than one method.
An entry with no payment recorded at all shows "Unpaid" rather than
blank, since that's exactly the thing worth noticing on a list.

One shared helper (`paymentSummary()` in format.js) used by both
screens, same discipline as `whoRecorded()` — Recovered Debt already
showed its own payment method and needed no change.


## Found: the actual "Ikenna in MainBar" cause

Checked the underlying data directly — every MainBar debtor was
already correctly attributed to MainBar's own staff (Chidera, Prosper,
the Store Manager). Ikenna's name was never in the credit data itself.

The real cause: the staff-filter chips at the top of the Credit page
were loading every bar/front-desk staff member branch-wide
(`loadBarStaff`), regardless of which department chip was selected —
so switching to MainBar still showed Ikenna's name as a selectable
filter option, even though he has no MainBar activity at all. Fixed
to use the same department-scoped lookup already built for the Sales
screen's on-behalf-of picker (`loadStaffForLocation`), and a stale
filter selection now clears when switching departments rather than
silently persisting. No database change — the underlying credit
records were correct the whole time; only the filter chips were
unscoped.


## The "OpenBar debtors showing under Minimart" bug: found

Long diagnostic path, but the finding is genuine: an existing
race-condition guard on Credit's data fetch keyed off only the
location. When switching departments auto-cleared a stale staff
filter (a person from the previous department no longer belonging on
this one), that fired a SECOND refresh — but the FIRST fetch's
response could still arrive while `locId` was correctly Minimart,
carrying the previous department's `staffFilter` inside the query.
That older response was accepted (its location was still current) and
overwrote the newer, correct data. Effect: chips looked right, staff
chips updated correctly, and the debtor list showed the previous
department's rows under the new department's heading.

Fixed by widening the guard from `locId` alone to a combined
`locId|staffFilter` request key — a fetch response now only applies
itself if BOTH the location and the filter it was originally sent for
are still the ones the screen wants. Chased through several rounds
of diagnostics that individually kept turning up clean: database
filtering was correct end-to-end (67, 70), sales attribution was
clean (68b), and the bug was ultimately client-side in a corner
neither the code nor an isolated test could catch without the exact
sequence of clicks that triggers it.


## Awka Store Manager: on-behalf-of removed entirely

Both sales and repayments. Pinned to their specific staff id
(a5ea88b6-...) rather than the storekeeper role, so a role change
doesn't quietly reopen it and Nnewi's storekeeper (or any future
Awka storekeeper) is unaffected.

- Sales: the "Recording on behalf of" picker is hidden for this
  account. A database trigger blocks the same at the write layer,
  so a hand-crafted API call can't work around it either.
- Repayments: the "Record payment" button is hidden on any customer
  whose balance is already attributed to someone else. Deliberate
  choice: credit stays with whoever originally gave it — this
  storekeeper is simply not the one who collects those. Same
  database trigger backs this at the write layer.

An earlier draft of this fix would have credited any storekeeper-
collected repayment to themselves, silently shifting accounting away
from the original credit-giver. That's not what was asked for; the
final version keeps attribution correct and just removes the
storekeeper from the collection path when it isn't their own credit.


## Auditor can correct a submitted count before verifying

Previously, once a count was submitted the counted figures were
read-only for everyone — an auditor faced with an obvious staff typo
(50 entered instead of 5) could only approve the wrong number or
delete the whole count and start over. Now the auditor can edit the
counted quantity directly on a submitted count, then verify.

Chose Option A (overwrite) per the decision — the corrected number
replaces the original. One safeguard kept so it isn't a silent
rewrite: a corrected line is flagged `auditor_adjusted` and shows an
"adjusted" marker, so the history still records that a correction
happened even though the original figure isn't preserved. The
corrected value flows straight into the stock adjustment at
verification (verify reads counted_qty live), and the existing
completeness check still applies — an adjusted line can't be left
blank. Auditor still cannot touch a verified count (locked) or a
draft (belongs to whoever is counting).
74_auditor_edit_submitted_count.sql.


## PR/free and damage now capture a reason

Both were previously bare stock movements with a generic note.

- Damage: a required fixed-list reason (breakage, expiry, spillage,
  theft, spoilage, other) plus an optional note. Save is blocked
  until a reason is picked, so damage can actually be counted and
  investigated by cause. Stored in a new `damage_reason` column,
  constrained to the known set (77_writeoff_reasons.sql).
- PR/free: a free-text "Authorized by / note" field, so who
  authorized it and why is on record. No approval workflow — capture
  only, per the decision.

The reason and note now show on each write-off row in Corrections,
where they'd actually be reviewed. A `v_writeoffs` view is also added
for GM-level investigation across all write-offs with reason, value,
and who recorded each. The new fields thread through the offline
outbox too, so a write-off recorded with no connection keeps its
reason when it syncs.


## Auditor can now record PR/damage write-offs

Explicit, acknowledged exception to the auditor's view-only design,
at the user's request. Scoped tightly at every layer:

- RLS (80_auditor_writeoffs.sql): the auditor gains insert on
  stock_movements for movement_type in (damage, complimentary) ONLY —
  not sales, transfers, issues, or anything else. Their read-only
  stance on everything else is unchanged.
- UI: since the auditor has no Sales screen (where the write-off
  button normally lives), the entry point is their existing Stock
  tab — pick a department, tap an item, the PR/damage sheet opens.
  Non-auditor roles keep recording write-offs on the Sales screen as
  before; Stock stays read-only for them.

The PR/damage sheet was extracted into a shared `WriteoffSheet`
component so the Sales-screen and Stock-screen (auditor) entry points
use one definition — same reason fields, same validation, no drift.
The Sales screen still uses its own inline copy for now; the shared
component is what the auditor path uses. (Worth unifying the Sales
screen onto it later, but that's a bigger refactor of a
daily-critical screen and wasn't needed for this.)


## Stock code hidden from catalog

The "Stock code" input is removed from the add-item form — it wasn't
useful to enter by hand and wasn't shown on the catalog list anyway.
The column stays (it has a per-branch unique NOT NULL constraint, so
it can't just be dropped), and is now auto-generated from the item
name plus a short random suffix. createItem retries once with a fresh
suffix on the rare chance of a collision, so the unique constraint
can never surface as an error the person can't act on. No database
change.


## Unfinished-task nudge (draft stock counts)

A persistent banner now appears on every tab when a stock count has
been started but not submitted — the "incomplete task left rotting"
case. Tapping it jumps to the Counts tab to finish or discard; it
hides itself while you're already on that tab.

Deliberately scoped to draft counts rather than a generic
"any incomplete task" system: a draft count is the one genuinely
real, resumable started-but-unfinished state in the app, and it maps
exactly to the example given. It reuses the existing stock_counts
table and its RLS — so a bar hand sees only their own unfinished
drafts, a manager/gm sees the branch's — on the same 60s refresh
cadence as the awaiting-verification badge. No database change.
(Submitted-awaiting-auditor counts already had their own badge from
earlier; this covers the other end — never submitted at all.)


## Store history extended to all four modes

Previously only Issue (OUT) had a history list. Now Receive (IN),
Move Between Depts, and Convert each have their own, matching the
same collapsible pattern:

- Receive: what's arrived into the store, with supplier/received-from
  note.
- Move: what's left the selected FROM department (the one picked
  first in Move mode).
- Convert: conversions at the selected department, showing the full
  "X → Y" detail from the movement note (one row per conversion, read
  from the produced-item side).

One shared reloadHistory() drives all four — it picks the right query
for the active mode and is called both on mode/department change and
after any successful save, so a just-recorded action shows
immediately. No database change; all four read the existing
stock_movements rows.


## Cross-branch default_location_id bug (zero stock until a tab is tapped)

Kelvin and Caleb (both Nnewi bar hands) had default_location_id
pointing at AWKA's OpenBar — a different branch's location. On load
their pages defaulted to an id that doesn't exist in Nnewi's data, so
every stock total read zero until they manually tapped the OpenBar
tab (which set the correct Nnewi id). Classic "works only after I
click something" symptom.

Fixed both ways:
- Code (loadBranchData): the stored default is now validated against
  the locations the person can actually see in the CURRENT branch. If
  it doesn't match (cross-wired or stale), it falls back to their
  first visible sales point. So no default can ever blank a screen
  again, for any account, on any page, including after a Nnewi↔Awka
  switch. This is the durable fix.
- Data (103_fix_crosswired_defaults.sql): repointed the two affected
  accounts to their own branch's assigned location, matched via their
  staff_locations rather than a hardcoded id. Not strictly needed once
  the code tolerates it, but the stored data should be correct too.


## Branch switch left the location chip unhighlighted (GM)

On Sales, Credit, and Recovered Debt, the selected-location state was
set once via useState's initial value — which React ignores on later
renders. So when the GM switched branch, the selected location id
stayed frozen at the OLD branch's OpenBar, matching no chip in the
new branch: nothing highlighted until a manual tap re-set it to a
valid id.

Fixed on all three pages with a re-sync effect keyed on
staff.branch_id: when the branch changes and the current selection
isn't a valid location for this branch, it resets to the branch's
default. Related to but distinct from the cross-wired
default_location_id fix — that was a bad stored default; this is
stale in-component state after a switch.


## PWA install — activated for iPhone and Android

The PWA groundwork already existed (manifest, full icon set, iOS
Safari meta tags, a well-written network-first service worker that
never caches live data). Two gaps closed:

- **Service worker was never registered.** sw.js sat in public/ doing
  nothing. Now registered in main.jsx (after load, non-blocking,
  fails silently) so the offline shell actually works.
- **No install guidance.** Added InstallHint: on Android/Chrome it
  catches beforeinstallprompt and shows a one-tap Install button; on
  iOS Safari (no such event exists) it shows "Share → Add to Home
  Screen" instructions after a short delay. Hidden when already
  installed (standalone), and stays dismissed 14 days once closed so
  it never nags.

No app stores involved: staff install straight from the browser.
iPhone users must use Safari (iOS only allows PWA install from
Safari); Android is more forgiving. Updates are instant on next load
after a Netlify deploy — no review, no fees.


## New app icon (inventory boxes)

Replaced the clipboard-and-check icon with three dark boxes stacked in
a pyramid on the amber tile — reads clearly as stacked inventory at
any size, from a 16px browser tab to a home-screen tile. Regenerated
all referenced files from one design (icon.svg, icon-192, icon-512,
apple-touch-icon 180, maskable 512, maskable svg) via cairosvg. The
maskable version is full-bleed (no rounded corners) so Android can
crop it to any shape; the regular one keeps the rounded tile for
browser tabs. No code change — the manifest and HTML already point at
these filenames.


## In-app logo matches the new icon

Updated the Logo component (used on the sign-in page and the header)
from the old clipboard-and-check line drawing to the three stacked
boxes, matching the new app icon. Drawn in currentColor so it stays
amber via text-amber on the app's dark background — just the boxes, no
tile, since the app already provides the dark backdrop. One component
change updates both the large sign-in logo and the small header logo.


## Reception & Order — charging items to a hotel room

New "Charge to a room" button on the Sales screen, available to any
staff who can record sales (not gated to managers, since taking a
room order is an everyday task, not an admin action).

This isn't a new subsystem — it writes directly into the front-desk
app's own `stays`/`orders`/`order_items` tables, in the same Supabase
project. Confirmed via their actual schema and RLS (not guessed from
their frontend code): both branch ids matched exactly what this app
already uses, and `orders`/`order_items` already had a fully
permissive `can_see_branch()` policy — no new security was needed for
this app's staff to write there.

What WAS missing, exactly as the front-desk app's own README flagged:
"when inventory arrives, setting [stock_item_id] is the only change
needed." Two things, not one — `order_items` had no `location_id`, so
there was no way to know which department's stock a room charge
should decrement. 108b adds that column and a trigger
(`sync_order_item_stock_movement`) mirroring the existing
`sync_sale_stock_movement` exactly — same insert/update/delete
symmetry, so editing or deleting a room charge doesn't leave a stray
stock movement behind. Uses a new `room_charge` movement type (108a)
rather than reusing `sale`, so stock history can tell the two apart.

Flow: search a live stay by room number or guest name → pick an item
from a NEW cross-department picker (RoomItemPicker) that shows every
department actually holding stock of it, not just the one you're
standing at — this is what lets a food order taken at OpenBar pull
from Kitchen's stock. Each item posts immediately as its own order,
matching exactly how the front-desk's own folio drawer already adds
charges one at a time — so a guest's bill looks identical regardless
of which app added it to. Category (drink/food/minimart) is inferred
from the department name, matching the three categories the front
desk already uses.

Deliberately does NOT create a `sales` row — a room charge is settled
by the front desk at checkout, not by this department's own till, so
folding it into this app's own daily reconciliation figures would
double-count revenue that hasn't actually been collected yet. It only
affects stock levels, which is correct: the drink is gone the moment
it's poured, whoever eventually pays for it.
