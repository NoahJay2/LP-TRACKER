# Lumen Peptides Tracker — Development Log

A summary of the iterative changes made during a single development session, organized by area.

---

## Inventory auto-sync with shipments & orders

- **Shipments → inventory:** when a shipment is marked Delivered, the matching stock product's `qty` is incremented by the shipment's `kits`. Reverting the toggle subtracts. Implemented as `applyShipmentInventoryDelta(shipment, isDelivered)` in `app.js` and wired into the per-row toggle, the group toggle, and the shipment modal save path.
- **Orders → inventory:** when an order is marked **Paid** (later changed from "on save"), each item's qty is deducted from the matching stock product. Toggling Paid back restores the qty. Editing items on a paid order computes a delta. Deleting a paid order restores qty.
- Stock match is by product name, case-insensitive trim. Out-of-stock products are auto-flipped back to ACTIVE when qty rises above 0.
- Each path also pushes the affected stock rows to Supabase via `cloudUpsert(Many)('stock', …)` and re-renders Inventory + Dashboard.

## Dashboard

- **KPI tiles:** added "Pending Net (Unpaid)", "Gross Profit (Revenue − COGS)", and "True Net Profit (Gross Profit − Expenses)". Renamed older labels for accuracy. Inventory Value switched from `qty × cost` to `qty × price` (matches the Inventory page's "Stock Value (Gross)" column).
- **Monthly Overview:** card renamed from "Monthly Revenue". Each row now shows revenue + net profit per month with a totals row at the bottom.
- **Recent Orders / Pending Orders:** split into two cards. Pending Orders sits *above* Recent Orders. Recent Orders is filtered to **completed** orders only (`paid && delivered`); Pending Orders shows everything unpaid. Cap = 5 for Recent.
- **Pending Shipments:** consolidates by `vendor + dateOrdered` OR shared tracking number into one drop-down row. Vendor leads each entry — `**Vendor** — Product` for single, `**Vendor** — N items` (chevron) for multi.
- **"Lumen Peptides" brand → home:** sidebar brand and topbar title both have `data-view="dashboard"` so tapping/clicking returns to the Dashboard.

## Orders page

- Customer-day grouping with a chevron drop-down for multi-order groups. Items column shows per-row count badge.
- **Status flags:** rows now visibly mark mismatched paid/delivered states.
  - Delivered + Unpaid → red left rail + tint + ⚠ icon
  - Paid + Undelivered → light-green left rail + tint + ⏳ icon
  - Multi-item rows get a blue rail; multi-order groups stack rails (blue + red + green) when their children include both kinds of issues.
- **Tap-to-expand restricted** to *Customer* and *Items* cells only — Date, Qty, Total, Profit, switches and actions no longer toggle the row.
- **Expanded child cards** use a single `<td colspan="N">` with a flex strip inside (`.child-cell` / `.child-strip`). Reliably full-width on mobile (the prior `<tr>` + `display:flex` had inconsistent width across browsers).
- Child strip shows: ↳ label, item pills, **QTY · Total · Profit** with small uppercase labels (matches the toggle-row Paid/Delivered labels), and edit/delete on the right.
- **Date column** displays as `M/D` (no zero-padding) on the Orders page only.
- **"N orders" badge** removed from the customer cell.
- **Mobile:** product name (single-item) or "N items" (multi-item) shows as a sub-line under the customer name since the Items column is hidden on phones.

## Order modal

- **Typeable product input:** `<select>` replaced with `<input list="orderProductList">` + `<datalist>`. Type to filter; selecting a match auto-fills price + cogs.
- **COGS column hidden** in the items list. Cogs is still tracked internally (auto-filled from product cost) — only removed from the visible 4-column grid (Product · Qty · Price · ×).
- **Paid / Delivered toggles** restyled as `.toggle-row` cards (label on left, `.switch` on right, soft green tint when checked).
- Column labels (`PRODUCT QTY PRICE`) visible on mobile too.

## Shipments page

- **Multi-line entry only:** the New Shipment modal supports adding multiple product rows; on save, one shipment record is created per line, all sharing Vendor / Date / Tracking / Delivered. Edit modal stays single-line.
- **Consolidation rule:** rows collapse into one drop-down when they share `vendor + dateOrdered` OR a tracking number. Implemented as `consolidateShipments(shipments)`.
- **Tracking column:** displays on the parent row on both desktop and mobile. Shared tracking shows on the consolidated parent row; child rows in the expanded card no longer repeat it. Long tracking numbers use `word-break: break-all` to wrap.

## Expenses page

- **Multi-item per expense:** each expense has an `items[]` array; `costMode` ∈ `{'total', 'perItem'}` with a "Track cost per item" toggle and an optional Total Cost input.
- **Vendor field added** at the top of the modal; column structure on the page: Vendor · Date Ordered · Products · Total Cost · Actions. Date Received removed from the table (kept in the modal). Mobile column-hide rules updated accordingly.
- **Cross-expense consolidation** by `vendor + dateOrdered` via `consolidateExpenses`. Multiple receipts the same day from the same vendor collapse into one drop-down.

## Supabase / cloud sync

Several rounds of column additions on the Supabase tables — the user runs each SQL once in the SQL Editor:

```sql
-- Multi-item expenses
alter table expenses add column items     jsonb default '[]'::jsonb;
alter table expenses add column vendor    text  default ''   not null;
alter table expenses add column cost_mode text  default 'perItem' not null;
```

Adapters (`Adapters.{stock,orders,shipments,expenses}`) were updated for each new column with appropriate fallbacks. Migrations (`migrateOrders`, `migrateExpenses`) backfill the new fields on existing local data so nothing breaks for already-stored records.

## Auth + deployment

- **Login overlay:** Supabase email/password auth gates the app. Session persists across refreshes (`localStorage`-backed Supabase client). `lockBodyScroll()` for the login overlay uses a separate `body.locked` class.
- **Sign-out** button in the sidebar.
- **No-flash refresh:** `body.app-booting` hides both the app and the login overlay until `sb.auth.getSession()` resolves. Fixes the brief login-screen flash when reloading with a saved session.
- **Vercel deploy:** `vercel.json` pins `outputDirectory: "."` so the site serves from the project root (the `public/` folder was being auto-detected as the output dir, deploying only `lplogo.png`).
- Recommendation: keep Vercel "Standard Protection" disabled if you want the URL accessible without a Vercel account (Supabase auth + RLS still protect the data).

## Mobile responsiveness

- Mobile column-hide rules scoped with `tr:not(.child-row)` so collapsed parent rows hide their compact-cells while expanded child cards still show their content.
- `.main` and `.card` padding reduced on phones; tables stretch edge-to-edge inside cards.
- `.child-strip` is always full width via `<td colspan="N">`; flex children inside use `flex: 1 1 200px` for the items area, fixed-size for stats / toggles / actions, with `flex-wrap` to handle narrow screens.
- iOS body scroll lock uses `position: fixed` with the saved `scrollY` set as a negative `top` to reliably block underlying-page scroll while a modal is open.

## Misc polish

- **Login screen** centered layout with a 64×64 indigo-haloed logo, blue-accent gradient on the Sign In button, dark gradient backdrop, focus rings on inputs, error message slot.
- **Apple touch icon + PWA meta tags** in `index.html` so the home-screen shortcut on iOS uses the logo with a "Lumen Tracker" label and runs full-screen.
- **Multi-item / status-flag visual cues** stack as left-edge bars on rows: blue (multi-item), red (delivered+unpaid), green (paid+undelivered) — up to 3 bars side-by-side on consolidated groups whose children carry mixed flags.
- **Expense modal** simplified: one shared 2-field grid for description + cost (`.exp-item-row`); 1-field grid in total-cost mode (`.no-cost`).

## File touchpoints

| File | Major edits |
|---|---|
| `app.js` | All render functions, modal definitions, migrations, adapters, inventory delta logic, scroll-lock helpers, `wireGroupExpand`, `consolidateShipments`/`consolidateExpenses`, `fmtDateShort`, status-flag helpers. |
| `index.html` | KPI tiles, dashboard cards re-ordered, login overlay, Apple meta tags, `data-view` on brand elements, table column header changes (Shipments, Expenses), `body.app-booting`. |
| `styles.css` | Login styling, toggle-row styling, child-cell / child-strip layout, status-flag rails, mobile media-query rewrites, scroll-lock body class, mobile column-hide rules. |
| `vercel.json` | Static `outputDirectory: "."`. |

---

# Session 2 — Filtering, Inventory Math, UX Polish

## Order modal
- Customer field gets a `<datalist id="orderCustomerList">` of unique past customer names — autocompletes as you type, but new names are still accepted.
- New orders start with a **blank** product field (no first-stock pre-fill); items default to `qty: 1, price: 0, cogs: 0`.
- Per-item × button always works (no more `disabled`); on the last remaining item it resets the row to blank instead of being a dead tap target.
- Performance fix: selecting a product no longer rebuilds the entire items list — only the price input value is updated, and `el.blur()` dismisses the keyboard / datalist popover. Previously the form froze after the second line.

## Monthly page
- New filtering toolbar mirrors Orders: search input with × clear, status filter (paid/all/unpaid), Month dropdown, Day dropdown. All persist via `persistFilter`.
- Three-level accordion: Month row → Day rows (showing `M/D` + ORDERS/TOTAL/PROFIT labeled stats) → Customer cards (consolidated by case-insensitive name with combined Total/Profit) → expand a customer to see item pills.
- Days within a month and months themselves render newest-first; `[hidden]` overrides added (`.day-orders[hidden]`, `.day-order-items[hidden]`) to defeat `display: flex` specificity.
- Top Products card relocated from the dashboard to below the monthly table; reflects the current filter (status + month + day + search).

## Dashboard refresh
- "Monthly Overview" + "Top Products" cards replaced with a single **This Month** card that shows the current calendar month only, with a **See more →** link that navigates to the Monthly page.
- This Month tiles: Revenue, Net Profit, Orders, Units Sold, plus Pending Revenue and Pending Net (orders this month not yet paid+delivered).
- Tile palette: indigo for revenue, green for net, amber + dashed border for pending. Same accents now applied to the page-top KPI tiles (`.kpi-revenue`, `.kpi-net`, `.kpi-pending`, `.kpi-inventory` cyan, `.kpi-expenses` red, plus a colored left rail).
- "Recent Orders" → **Recently Completed Orders** (paid AND delivered). Pending Orders now includes any incomplete order (unpaid OR undelivered) and is sorted oldest-first so it doubles as a fulfillment queue.
- Pending Orders card uses real toggles (paid/delivered) so orders can be completed without leaving the dashboard. Recently Completed renders read-only (toggles hidden via `#recentOrdersTable` CSS).
- Profit column added to both dashboard tables. Mobile compresses padding and scales `.switch` to 0.85 so all six visible columns fit.
- Dashboard table renderers (`renderRecentOrderRow`, `renderRecentOrderGroup`) now use `fmtDateShort`, customer-sub on multi-item / multi-order rows, and a shared `wireOrderInteractions(body)` helper for toggle/edit/delete wiring.

## Filters & persistence (every list page)
- Generic helper `persistFilter(el, key)` writes to localStorage on `input` and restores on render. Applied to: Orders search/status/month/day/sort, Inventory search/filter, Shipments search/filter/sort, Expenses search/month/day/sort, Monthly search/filter/month/day.
- New helper `wireSearchClear(input)` adds an inline × clear button (custom `.search-wrap` markup) that re-fires the input event so listeners + localStorage stay in sync.
- New **Sort direction** dropdown ("Newest first" / "Oldest first") on Orders, Shipments, and Expenses. Honored both by the underlying row sort and the consolidated group sort.
- Day dropdowns scope to dates within the selected month and auto-reset to "All Days" when the saved day isn't in the new month.
- Mobile toolbar layout: search-wrap takes a full row; selects flex-share a single row instead of stacking. Padding tightened to `10px 8px`.

## Shipments — inventory tracking, kits/qty units, group editing
- **Cutoff:** `SHIPMENT_INVENTORY_CUTOFF = '2026-04-14'` — only shipments ordered after this date contribute to inventory deltas. Older records become historical.
- **Kits vs Qty unit:** each shipment has `unit ∈ {'kits','qty'}` (default `kits`). 1 kit = 10 vials via `KIT_TO_VIAL_MULTIPLIER` and `shipmentVialCount(s)`. Toggling Delivered now adds/subtracts vial count instead of raw kits.
- **Auto-add to inventory:** new helper `ensureStockProduct(name)` returns `{ product, created }`. When a shipment names a product not in stock, a new `qty:0` stock entry is created automatically; once delivered, kits-converted vials are added to that entry.
- **Datalist autocomplete:** New & Edit Shipment modals now use `<input list="shipProductList">` so typing filters existing products and a brand-new name is accepted.
- **Edit-the-whole-group modal:** parent row of a consolidated shipment group has its own ✎ button → opens `shipGroupModal(groupShipments)`. Lets the user edit shared fields (Vendor, Date, Tracking, Delivered) once and propagate to every child, plus add/remove/edit each line's product/amount/unit. Inventory is reverse-then-reapply across the whole batch on save. Includes a "Delete Entire Group" outlined-danger button.
- **Cleaner display:** removed the standalone Amount column. Each shipment line renders as an `.item-pill` with `Product ×N` for qty or `Product ×N Kit/Kits` for kits (pluralized). Single-shipment rows use the same pill. Expanded group children use real table cells with the product pill via `colspan="3"` so long names stay on one line and other values align under their parent columns. Per-line unit displayed in the Amount-cell display ("4 Kits" / "×3").
- Schema migration: `migrateShipments` defaults legacy records to `unit: 'kits'`; Adapters round-trip the field. **Required SQL:** `alter table shipments add column if not exists unit text default 'kits' not null;`

## Expense modal & display
- **Track cost per item** styled as a full-width `.toggle-row` card matching the order/shipment Paid/Delivered look, with a small muted helper line (`On = enter cost on each line · Off = enter a single total`).
- Each item line gains: typeable product input (`<datalist id="expProductList">` from inventory), Qty number input, Unit dropdown (Qty/Kits), and a Cost field shown only in per-item mode.
- Items section gains a **Vials** stat in the summary applying the kit→×10 math.
- Total Cost reading bug fixed: `updateSummary` and `modalOnSave` now read `data.totalCost` (kept in sync by the input listener) instead of the DOM element, which could be empty after a re-render.
- `Adapters.expenses.fromRow` defensively infers `costMode='total'` when `cost > 0` and the item sum doesn't match — survives a missing `cost_mode` column.
- Save flow now re-looks-up the live record by `existing.id` instead of mutating a captured reference, so a cloud sync between modal-open and save can't drop edits. Cloud upsert is awaited and surfaces errors loudly via alert.
- Display: each line item renders via `expenseItemLabel(it)` as an `.item-pill` (`Product ×N` or `Product ×N Kits`). Single-row expenses use `expenseCost(e)` (was `it.cost`, which read 0 in total mode). Per-line cost only shown in expanded children when `costMode === 'perItem'`.

## Inventory — cascade rename
- When you rename a product on the Inventory page, the save handler scans all shipments + order line items for case-insensitive matches against the old name. A confirm dialog summarizes the impact (`N shipments and M orders reference this product`). On confirm, every reference is rewritten to the new name; all three tables (`stock`, `shipments`, `orders`) sync to Supabase. Cancel aborts.

## Modal UX
- **Backdrop dismiss bug fixed:** dragging outside an input (selecting text, releasing a slider) used to land the click on the backdrop and close the modal mid-edit. Now requires the `mousedown` AND `click` to both originate on the backdrop.
- **Modal-body labels respect `[hidden]`:** the existing `display: flex` rule beat the UA `[hidden]` style, so `expTotalCostWrap.hidden = true` did nothing — added `.modal-body label[hidden] { display: none }`.
- **Edit Shipment** converted from generic `openModal` to a custom form so it can use the datalist autocomplete + labeled Unit dropdown + sleek `.toggle-row` Delivered + a full-width "Delete Shipment" outlined-danger button (with inventory reversal on delete).
- Inventory deltas on shipment edit: previous contribution is **reversed** with the OLD product/amount/unit, the live record is updated, then the new contribution is applied — handles product/amount/unit changes on a delivered shipment cleanly.

## iOS / mobile polish
- `<meta name="viewport" content="…, viewport-fit=cover">` so iOS exposes safe-area insets.
- Topbar pads its top by `env(safe-area-inset-top)` and grows its height accordingly so the solid background paints into the notch / Dynamic Island area; no more scrolled content peeking through above it.
- Sidebar / drawer-backdrop pin to `calc(56px + env(safe-area-inset-top))` to line up with the extended bar.
- Mobile topbar is now fully opaque (`var(--bg)`); the prior `rgba(20,22,28,.85)` + backdrop blur let content show through.
- **Swipe gestures:** right-from-left-edge (within 28px) opens the drawer; left-anywhere closes it when open. Disabled while a modal is open and gated to ≤900px.

## Misc small fixes
- `.items-cell` no longer uses `display: flex` on a `<td>` — it broke `table-cell` layout and made rows containing the chevron+badge taller than neighbors. Now uses inline children with `vertical-align: middle`.
- Order-row "x" remove button and customer auto-fill issues fixed (see Order modal).
- Order page footer reads `Total Orders N · M items · Total $X · Profit $Y` with inline labels (`.foot-label`); Profit visible on mobile.
- Shipments page mobile: Date Ordered visible (was hidden), `N items` badge surfaces on collapsed parent rows via `#view-shipments .grp-badge { display: inline-block }`. Same override added for `#view-expenses`.
- Pending Orders dashboard sorted oldest-first; Recently Completed kept newest-first.
- Months tab tabs are always collapsed on render; days within a month sort newest-first.

## Required SQL (run once in Supabase SQL Editor)

```sql
alter table shipments add column if not exists unit       text default 'kits'    not null;
alter table expenses  add column if not exists vendor     text default ''        not null;
alter table expenses  add column if not exists cost_mode  text default 'perItem' not null;
alter table expenses  add column if not exists items      jsonb default '[]'::jsonb;
```

## File touchpoints (Session 2)

| File | Major edits |
|---|---|
| `app.js` | `persistFilter`, `wireSearchClear`, sort-direction filtering, `KIT_TO_VIAL_MULTIPLIER` + `shipmentVialCount` + `SHIPMENT_INVENTORY_CUTOFF`, `ensureStockProduct`, `migrateShipments`, `shipGroupModal`, custom Edit Shipment modal, expense modal qty/unit/datalist, expense save robustness, cascade rename in `stockModal`, `expenseItemLabel` pill helper, dashboard `thisMonthCard` rendering, `renderMonthly` filters/Top Products, `wireOrderInteractions` helper, modal backdrop guard, swipe gesture handler. |
| `index.html` | Toolbar additions (search-wrap + sort dropdowns + month/day on Monthly + Expenses), shipments table header (Amount removed), KPI tile classes, dashboard "This Month" card replaces Monthly Overview/Top Products, Top Products moved to Monthly, viewport-fit=cover. |
| `styles.css` | `.kpi-*` variant accents, `.this-month` + `.tm-stat-*` tiles, `.search-wrap` + `.search-clear`, mobile toolbar packing, `.toggle-row-hint`, `.btn.danger-outline`, `.child-row.child-row-cells` multi-cell child variant, `.cs-product-cell`, monthly accordion (`.day-row`, `.day-order`, `.day-item-pill`), removed `.items-cell { display: flex }`, safe-area insets on topbar/sidebar/backdrop, modal-body `[hidden]` guard, `.foot-label`. |
| Supabase | `unit` column on `shipments` (kits is default). `vendor`, `cost_mode`, `items` columns on `expenses` already in place from session 1. |

---

## Session 3 — Today Card, Invoice View, Inventory Polish, Shipping & Notes

### Dashboard

- **Pending Orders card header** now shows `N pending · Total $X · Profit $Y`. Total/Profit only count truly **unpaid** orders — paid-but-undelivered no longer inflate the totals (their revenue is already booked). Paid-but-undelivered orders still appear in the list so they can be marked delivered.
- **KPI tile reordering & cleanup:** Total Expenses moved up between Gross Revenue and Gross Profit. **Units Sold** tile removed entirely. **Inventory Value** tile removed (now lives on the Inventory page).
- **"This Month" card** trimmed: removed Orders count and Units Sold tiles, then **Pending Revenue / Pending Net** tiles too. Card shrunk from `span-2` → half-width and renamed to **"This Month Completed"** so the Revenue/Net Profit numbers (paid+delivered only) read unambiguously.
- **"Today" snapshot card** added beside This Month Completed (`#todayCard`):
  - Header: `M/D · N orders` (`fmtDateShort` + unique-customer count).
  - 2×2 stat grid: **Total Paid** / **Net Profit Paid** / **Total Pending** / **Profit Pending** (paid vs unpaid scoping).
  - **To Do** / **Completed** sections below, one row per customer-day group, each row tappable.
  - **Overdue section** above To Do — incomplete orders with a date *before* today, grouped by `customer + date`, sorted oldest first. Each row shows `5/5 · 3d late` in red. Empty-state path now shows the Overdue section even when there are no orders today, so the dashboard never falsely reads as "caught up".
  - Status pills: always show both **Pay** and **Send** — green when done (`Paid` / `Sent`), amber when owed. Replaced "Ship" with "Send" since the user does shipments *and* in-person deliveries.

### Daily-log timezone fix

- `todayISO()` rewritten from `new Date().toISOString().slice(0,10)` (UTC) to local-component formatting (`getFullYear/getMonth/getDate`). Without this fix, an evening user west of UTC would see tomorrow's date as "Today". Same getter feeds This Month, the Today card, default order date, and Overdue cutoff — all corrected at once.

### Today popup (`openTodayOrderDetail`)

- Read-only popup invoked when the user taps a customer row on the Today card. Reuses the main modal with a new `modal-readonly` class (CSS hides Save button) and Cancel relabeled "Close". `closeModal()` resets both for the next regular modal.
- Function signature accepts `(customerKey, dateKey)` so overdue rows pass their own date — popup loads orders matching `customer + date`.
- **Detail view:** Date header, Paid + Delivered sleek toggles (operate on every order in the customer-day group at once, with inventory-delta rebalancing on Paid changes), per-item rows (name × qty / price-each / line-total), Total + Net Profit footer aligned to the same right edge as item totals via flex `space-between`.
- **Show Invoice** primary button swaps body to the invoice view; **← Back** restores the detail.

### Invoice view (`renderInvoiceView` — shared helper)

Extracted to a top-level reusable helper since both the Today popup *and* the order form's "View Invoice" button render the same layout.

- **Light "paper" panel** (white bg, dark text) sits inside the dark modal so screenshots look like a real invoice. Includes:
  - **Watermark logo** as a real `<img class="invoice-watermark">` (not a CSS pseudo — pseudo with relative URL fails to capture in some image-export libs; even though save-as-image was later removed, the real `<img>` is still the more reliable approach for native screenshots and renders consistently across browsers). 75% width, 12% opacity, centered, behind content via z-index.
  - **Header:** "Order Invoice" title (left), Date + Bill To meta (right). Date renders as `May 5, 2026` via new `fmtDateLong` helper using local components.
  - **Items table:** Item / Qty / Price / Total grid, monospace numerics, with subtotal/shipping rows when shipping > 0 above the **Total Due** line.
  - **Payment Methods block** (translucent so watermark passes through): Zelle 512-573-1342 (clickable as `tel:`), Apple Pay 512-573-1342, CashApp $NoahJx2. **Amber heads-up callout** below: *"Heads up — CashApp is strict. Please put 'for food' or '.' in the memo so the payment isn't flagged."*
  - **Notes block:** when `allowNotesEdit: true` (Today popup), `+ Add Notes` button → textarea → Save/Cancel — saves to every order in the group via `setNotesOnAll`. When `allowNotesEdit: false` (order form preview), notes render as static text only.
- **Save-as-image removed** — initial integration of `html-to-image` had repeated issues (cross-origin font-embed errors, watermark fetch failures). User opted to just take a native screenshot, so the CDN script + `saveInvoiceAsImage` + `getLogoDataUrl` + `.invoice-capturing` CSS were all torn out. The watermark `<img>` stayed.

### Order form

- **+ Add Notes** ghost button below Paid/Delivered reveals a labeled textarea. Notes round-trip through Supabase via the orders adapter (`toRow`/`fromRow`) and `migrateOrders` defaults legacy rows to `''`.
- **+ Add Shipping Charge** ghost button reveals a `$` input with an inline × that collapses back. Live-updates the items summary so Total reflects items + shipping. Saves with `0` if the toggle is hidden when the user clicks Save (avoids stale input values leaking through).
- **View Invoice** ghost button: captures the form's current state (customer, date, paid, delivered, notes, **shipping**, items) into a draft, swaps the modal body to `renderInvoiceView({ ..., allowNotesEdit: false, onBack: () => orderModal(existing, draft) })`. The Back button re-opens the form **with the draft restored**, so previewing doesn't lose unsaved edits. `orderModal` accepts an optional second `draft` parameter.
- **Delete Order** button (only when editing) — outlined-danger style, confirms, restores inventory if the order had been paid, deletes from state + cloud, refreshes views, closes modal.
- `orderModal` resets `modal-readonly` + Cancel-text on every entry, so re-opening from a popup state always lands in normal Save/Cancel mode.

### Order data model — shipping & notes

- **`Adapters.orders.toRow`/`fromRow`** round-trip both `notes: text` and `shipping: numeric`.
- `migrateOrders` defaults legacy orders: `notes: ''`, `shipping: 0`.
- **Helper functions:**
  - `orderShipping(o)` — single source of truth.
  - `orderItemsTotal(o)` — items-only revenue (used as the invoice subtotal).
  - `orderTotal(o)` = items revenue + shipping. Used everywhere revenue is summed (dashboard tiles, monthly buckets, order rows, etc.) so shipping flows through the entire app automatically.
  - `orderProfit(o)` = items profit + shipping. Shipping is treated as pass-through profit (no offsetting cost in the model). Top Products by-product breakdown still works correctly because it iterates `items[]` directly and naturally excludes shipping.

### Inventory page

- **Summary blocks at the top** (`.kpi-grid.inv-kpi-grid`): four tiles — **Total Products**, **Gross Stock Value** (revenue accent), **Net Stock Value** (net accent), **Profit Margin** (cyan, `Net / Gross × 100%`). All recompute against the active search/filter (e.g. filtering to "Low Stock" recalculates the totals to just those rows).
- **Removed table footer** (and the mobile workaround that packed totals into the count cell). Cleaner: top-of-page tiles, table below, no footer noise.
- **Mobile toolbar fix:** the inventory search input previously used a plain `<input>` and shared 50/50 width with the filter dropdown, leaving empty space on the right. Switched to the `.search-wrap` pattern (with × clear button) used by every other page; on mobile that pattern takes a full row via `flex: 1 1 100%`.

### Top Products card (Monthly page)

- **Collapsed by default** behind a `View Top Products ▾` toggle button (state persisted in localStorage as `lumen.topProducts.open`).
- **Independent toolbar** with Status / Month / Day / Sort By / Limit dropdowns — does NOT inherit the months-table filters. All persisted with their own keys.
- **Display** changed from a single-metric `<ul>` to a 4-column `<table>`: Product / Total Gross / Total Net / Quantity Sold, with a **Grand Total** footer.
- **Grand Total** sums only the rows actually displayed (post limit-slice) — picking "Top 5" makes the Grand Total reflect just those 5.
- 18px gap added between the months card and the Top Products card.

### Monthly page — date range filter

- Replaced the single Day dropdown with a **From → To** pair of native `<input type="date">` fields wrapped in `.date-range`. Native pickers give us OS calendar UI on iOS and a calendar popup on desktop, so single-day or range selection works for free.
- Filter logic: ISO YYYY-MM-DD strings compare chronologically as plain strings, so `o.date >= dyFrom` and `o.date <= dyTo` work without `Date` parsing. Either bound can be left blank for open-ended ranges.
- Both inputs persisted with separate keys (`lumen.monthly.dateFrom` / `lumen.monthly.dateTo`). Reset button clears both. Removed `refreshMonthlyDayDropdown` helper entirely.

### Filter persistence — Reset Filters buttons

Every filterable page now has a small `.btn.ghost.btn-reset` "Reset" button at the right end of its toolbar:

- Orders, Inventory, Shipments, Expenses, Monthly (main filters), and the Top Products card's own filters.
- Generic `resetFilters(elements)` helper clears each control to its default — selects honor the option marked `selected` in the HTML (so Top Products' Limit goes to "Top 10", not the first option "Top 5"), text inputs clear to empty. Dispatches `input` events so `persistFilter` writes the defaults to localStorage and any subscribed render runs immediately.
- **Orders default sort changed** to **Oldest first** (`<option value="asc" selected>`) — fits the user's flow of fulfilling oldest first.

### Required SQL (Session 3)

```sql
alter table orders add column if not exists notes    text     default ''  not null;
alter table orders add column if not exists shipping numeric  default 0   not null;
```

### File touchpoints (Session 3)

| File | Major edits |
|---|---|
| `app.js` | `Adapters.orders` round-trips `notes` + `shipping`; `migrateOrders` defaults both. New helpers: `orderShipping`, `orderItemsTotal`, `fmtDateLong`, `resetFilters`, `renderInvoiceView` (top-level reusable). `todayISO()` rewritten to local time. `renderDashboard`: split paid/pending Today stats, To Do/Completed/Overdue sections, removed Units Sold + Inventory Value, pending-only filter for This Month Completed. `openTodayOrderDetail(customerKey, dateKey)` accepts a date for overdue rows; renders detail/invoice via toggle. `orderModal(existing, draft)` accepts a draft for View Invoice round-trips; adds Notes section, Shipping section, Delete Order button, View Invoice button. `renderInventory` writes to `invKpi*` tiles instead of footer. `renderMonthly` switched to From/To range filter; removed `refreshMonthlyDayDropdown`. New `renderTopProducts` with own filters + table layout + collapse toggle. Reset button wiring across all pages. `closeModal` resets `modal-readonly` + Cancel text. |
| `index.html` | Dashboard KPI grid trimmed (no Units Sold, no Inventory Value, Total Expenses moved up). New `#todayCard` next to `#thisMonthCard`. "This Month Completed" rename. Inventory page got `.kpi-grid.inv-kpi-grid` summary tiles + table footer removed; search wrapped in `.search-wrap`. Order form gained Notes/Shipping/View Invoice/Delete buttons. Monthly toolbar swapped Day select for `.date-range` From/To inputs. Top Products card collapsed structure with own toolbar + 4-col table + tfoot. Reset buttons on every filter toolbar. Default Orders sort = `asc`. |
| `styles.css` | `.tm-stat-pending` retained from session 2 but unused on This Month Completed. New `.today-row`, `.today-row-overdue`, `.today-row-date`, `.today-section-head-overdue`. `.readonly-detail` (rd-meta, rd-toggles, rd-items, rd-totals). Full `.invoice-*` suite: paper, watermark, header, items grid, subtotal-rows, total-row, payment-block, payment-note (amber callout), notes block. `.notes-section` + `.shipping-section` styles for order form. `.kpi-grid.inv-kpi-grid` consumes the standard `.kpi-grid` auto-fit grid. `.date-range` flex pair for the Monthly From/To. `.toolbar .btn-reset` compact reset button. `.top-products-card` 18px top margin + body styling. Removed `.invoice-capturing` rules and `.inv-mobile-extra`. |
| Supabase | New columns: `orders.notes` (text default ''), `orders.shipping` (numeric default 0). Both required for cloud sync to succeed when those fields are set. |

---

## Session 4 — Partial Payments, Discounts, Calendar Monthly View, iOS PWA Fixes

### Partial payments
- Orders gained a **`payments` array** (`[{ id, amount, date, method, note }]`). The boolean `o.paid` is now **derived** — true iff payments sum ≥ order total. `syncOrderPaidFlag(o)` keeps it consistent; `setOrderFullyPaid(o, bool)` is the shared shortcut used by all row/group/Today toggles (checking adds a balance payment dated today; unchecking clears payments).
- **Helpers:** `orderPayments`, `orderPaymentsTotal`, `orderBalance`, `orderIsFullyPaid`, `orderIsPartiallyPaid`, `orderPaidRevenue`, `orderPaidProfit`, `orderUnpaidProfit`.
- **Order modal Payments section:** add/remove payment rows (amount + date), live Paid / Balance summary + status pill (Unpaid / Partial / Paid in Full). "Paid in Full" toggle is a shortcut that tops payments up to the balance or clears them. Append-only row building (see below) so the keyboard stays up.
- **Accounting model (settled after iteration):** revenue is **cash-basis** (`orderPaidRevenue` counts partial payments); **profit is all-or-nothing** — a partial-paid order's full profit sits in Pending until it's paid in full (avoids fractional-cent pending-profit and matches the owner's mental model). Dashboard KPIs, Today/This-Month tiles, Pending header, and Income Statement all use these.
- **Partial chip:** compact amber `$X` chip beside the Paid toggle on rows (shows amount paid; tap opens the order). `orderStatusFlag` gained a `partial` state.
- **Migration:** legacy fully-paid orders synthesize one full-total payment so the new helpers line up.

### Discounts (percent or flat dollar)
- Order form **"+ Add Discount"** section: `$ Off` / `% Off` selector + value, inline resolved-amount indicator. Stored as `order.discount = { type:'percent'|'amount', value }`.
- **`orderDiscountAmount(o)` always rounds the discount UP to a whole dollar** (`Math.ceil(raw − 1e-9)` — epsilon guard so an exact whole dollar doesn't over-round). Applies to the eligible (non-excluded) items subtotal only; never exceeds it. Discount comes off both `orderTotal` and `orderProfit`.
- **Per-item exclusion:** "Apply discount to" checklist (shown when 2+ items) toggles `item.excludeDiscount`; `orderDiscountableSubtotal` skips excluded items.
- **Invoice:** discounted lines show ~~original~~ **discounted** price (struck-through), all rounded to **whole dollars** (whole-dollar per-line allocation, remainder on last line). Totals show discounted Subtotal, **"You saved (N% off)"** line (percentage shown when it's a single % discount), Shipping, Total Due.

### Invoice changes
- **Customer name removed** from the invoice header (Date only; green **PAID** stamp when fully paid).
- **Payments reflected:** each payment listed with date, **Balance Due** when partial, PAID state hides the payment-methods block.
- **Cash** added as a payment method (Zelle / Apple Pay / CashApp / Cash).

### Monthly → Calendar (3-level drill-down)
- Replaced the line-item table with **Year overview → Month calendar → Day detail**.
  - **Year view:** 12 month tiles, each showing gross / net / items; tap a month to open it. Prev/next year nav + year summary.
  - **Month view:** real calendar grid (Sun–Sat), each day with sales shows gross / net / item count + today highlight; back-to-year button + prev/next month nav + month summary.
  - **Day detail:** read-only modal — day totals + per-customer itemized breakdown.
- One delegated click handler on `#calCard`. **State persists** (`lumen.monthly.calState`: view/year/month) so closing and reopening lands on the same spot; Monthly **Reset** clears it. Removed the old month dropdown + date-range from the toolbar (search + paid filter remain).

### Smooth modal row entry (fixes mobile freeze)
- Orders items, payments, shipment items (new + group edit), and expense items now **append a single DOM row** on "+ Add" and **remove just that row** on ×, instead of rebuilding the whole list. Handlers close over the item reference (no `data-idx`). New rows auto-focus + scroll into view. Number inputs got `inputmode` hints.

### iOS / PWA fixes
- **`focusForKeyboard(input)`** helper: iOS Safari often won't open the keyboard for a freshly-appended input; focuses an always-mounted helper input first, then transfers focus. Used by all "+ Add" buttons.
- **Swipe gesture rewrite:** the drawer-open swipe decides its axis on the **first** touchmove (iOS commits scroll-vs-gesture there) and only `preventDefault`s clear horizontal edge swipes, so the page no longer jiggles vertically. The non-passive `touchmove` listener is attached **per-gesture** (only on edge/drawer-open touches) and removed on touchend — fixes the standalone-PWA bug where an always-on document touch handler suppressed input keyboards.
- **Standalone fullscreen kept** (`apple-mobile-web-app-capable: yes` + `mobile-web-app-capable`); status bar set to `default` (black-translucent had focus quirks).
- **Modal close button** enlarged to a 48×48 tap target on mobile, padded off the rounded corner.
- **Payments amount `$` prefix** overlap fixed (vertically centered, mobile padding re-asserted).

### Whole-dollar money hygiene
- `round2(n)` helper; migration scrubs item price/cogs, shipping, and payment amounts to cents. Dashboard / income / pending sums wrapped in `round2`. Profit values rounded per order. Payment + price inputs use `step="1"` / numeric keypad.

### Paid-not-saving fix
- `mergeCloudOrders` no longer **downgrades** a cloud-confirmed `paid=true` when the local cache only has a partial payment (e.g. balance payment added on another device, or `payments` column missing). Cloud `paid` is authoritative; a synthesized balance payment is added locally to reconcile.

### Cloud column-guard (generalized) + cache-busting
- Optional columns `payments` and `discount` are guarded: if Supabase rejects a write for a missing column, the app marks it missing, drops it, and retries (so the rest of the order still syncs). Old `payments`-specific flag migrated to the generic scheme. `mergeCloudOrders` preserves local `payments` when the cloud row has none.
- **Cache-busting:** `?v=…` query strings on `styles.css` + scripts, no-cache headers on HTML in `vercel.json`, and a **Build tag** in the sidebar footer (`BUILD_VERSION`) so the live build is verifiable at a glance.

### Vercel routing (404 fix)
- Root URL was 404ing because the app file is `tracker.html` (no `index.html`). Added `index.html` (redirect to `/tracker.html`) + `vercel.json` rewrites (`/` → `/tracker.html`, `/landing` → `/landing.html`), `cleanUrls`, and no-cache HTML headers. Deploy via `vercel --prod` (the CLI is installed globally as `vercel@54.x`; a stray `￼` paste char once caused an "unknown option: --prod" error — type the command, don't paste).

### Required SQL (Session 4)

```sql
alter table orders add column if not exists payments jsonb default '[]'::jsonb;
alter table orders add column if not exists discount jsonb;
```

(App functions without these — it caches locally and retries — but adding them backs payments/discounts up to the cloud and lets them sync across devices.)

### File touchpoints (Session 4)

| File | Major edits |
|---|---|
| `app.js` | `BUILD_VERSION` + build-tag stamp; `round2`; payments helpers + `setOrderFullyPaid` + `syncOrderPaidFlag`; `migrateOrders` payments/discount/whole-cents; discount helpers (`orderDiscountableSubtotal`, `orderDiscountAmount` ceil); `orderTotal`/`orderProfit` apply discount; generalized optional-column guard (`orderColumnAvailable`, `missingOptionalOrderColumn`, `upsertWithColumnRetry`); `mergeCloudOrders` paid-preserve; `orderModal` Payments + Discount sections, append-only `buildItemRow`/`buildPaymentRow`/exclusion list, value-based discount save; `focusForKeyboard`; per-gesture swipe handler with first-move axis lock; Monthly rewritten to `renderYearView`/`renderCalendar`/`openDayDetail` with persisted `calState`; `renderInvoiceView` per-item strikethrough + whole-dollar + percent label + payments + PAID stamp, customer name removed, Cash method. |
| `tracker.html` | Orders filter gained Partial/Paid-in-Full options; Monthly toolbar trimmed to search+filter+reset, table replaced with `#calCard` (head/summary/content); discount section markup; build-tag element; `?v=` cache strings on css/scripts; standalone PWA meta (`mobile-web-app-capable`, status bar `default`). |
| `index.html` | New file — redirect shim to `/tracker.html` (root-URL 404 fix). |
| `styles.css` | Payments editor + partial chip + paid-cell; discount section + `[hidden]` re-assert + exclusion checklist + invoice discount/strikethrough; calendar (cal-head/nav/back, months grid, day grid, summary, today badge) + day-detail modal; bigger modal close button + payment `$` prefix; build-tag; partial row tints; invoice PAID stamp + balance rows. |
| `vercel.json` | `rewrites` (`/`→tracker, `/landing`→landing), `cleanUrls`, `trailingSlash:false`, no-cache `headers` for HTML. |
| Supabase | Optional `orders.payments` (jsonb) + `orders.discount` (jsonb); app degrades gracefully if absent. |
