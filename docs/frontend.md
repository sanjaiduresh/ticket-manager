# DSA Service Desk frontend

React 19, TypeScript, Vite, Tailwind and shadcn/ui, with React Router, TanStack Query, Recharts and Lucide icons. Live data comes from **same-origin Express + MongoDB**, with protected Cloudinary images delivered through the API.

## Structure

| Source | Responsibility |
| --- | --- |
| [src/App.tsx](../src/App.tsx) | Session restoration, access/password gates, company shell and role-based routes. |
| [src/features/auth.tsx](../src/features/auth.tsx) | Login, immediate owner registration and passwords. |
| [src/features/tickets.tsx](../src/features/tickets.tsx) | Queue/detail, workflow, activity and images. |
| [src/features/customers.tsx](../src/features/customers.tsx), [outages](../src/features/outages.tsx), [team](../src/features/team.tsx), [reports](../src/features/reports.tsx) | Operational screens. |
| [src/features/performance.tsx](../src/features/performance.tsx) | Owner-only employee activity and current assignments. |
| [src/lib/reporting.ts](../src/lib/reporting.ts), [src/components/reporting.tsx](../src/components/reporting.tsx) | IST ranges, cohort filters, CSV rows, demo audit metrics and shared Recharts/table views. |
| [src/lib/http.ts](../src/lib/http.ts), [data](../src/lib/data.ts) | Same-origin cookie requests and live `DataApi`. |
| [src/lib/session.ts](../src/lib/session.ts), [queries](../src/lib/queries.ts) | Nonsecret session hint and tenant-scoped cache lifecycle. |
| [src/lib/types.ts](../src/lib/types.ts), [registration](../src/lib/registration.ts), [format](../src/lib/format.ts) | Contracts, validation, IST dates, CSV and activity formatting. |
| [src/lib/demo.ts](../src/lib/demo.ts), [runtime](../src/lib/runtime.tsx) | Fictional repository/runtime context. |
| [src/components/shared.tsx](../src/components/shared.tsx) | Shared UI using shadcn primitives. |

## Run and connect

Use **Node 24**, `npm ci`, then `npm run dev`. It starts both API and Vite; open **http://127.0.0.1:5173**. `/api` proxies to port **3001**, preserving same-origin cookies. [Backend setup](backend-setup.md) documents server-only variables and Atlas/Cloudinary configuration. No browser credentials or `VITE_` secrets are needed.

`npm run build` typechecks/builds assets. Production uses **Node 24**, **`NODE_ENV=production`**, and **`npm start`** to serve built frontend and API on one HTTPS origin matching `APP_ORIGINS`. Without production mode, `npm start` does not serve built assets. `npm run preview` previews assets only. Static Cloudflare Pages alone cannot run the backend; a persistent Node service is required. No deployment was performed.

The office laptop needs only the app URL/login, not personal infrastructure accounts. A trusted operator configures hosting privately from an authorized personal device. Free hosting depends on current commercial-use terms, availability, quotas and sleep; no subscription or permanently free uptime is promised.

## Registration, sessions and access

**Register owner** takes company name, full name, email, password and confirmation. Only `company_name`, `full_name`, `email`, `password` go to `POST /api/auth/register`. **201** with `ok` and normalized `email` confirms immediate company/owner creation. The UI clears passwords, prefills email and asks the owner to sign in separately; there is no automatic login/retry.

**No SMTP, verification email, confirmation callback, Finish company setup, setup code or owner-email allowlist. Email is an unverified identifier**, not identity proof. For uncertain registration, check sign-in/account state before retrying. Missing profile/company means access/configuration error, not permission to complete old signup.

One company per account; normalized emails are unique across the database. Signup creates a new independent company, not membership in another. Owners create office/technician accounts through **Team** and privately hand over temporary passwords. Staff must change them before operational access; Team cannot mutate owners. Own password changes require the current session's sign-in to be **less than 15 minutes old**; sign out/in when asked. This is a recent-login requirement for the sensitive password change, **not a general session timeout**. A successful own password change retains the current session and revokes all other sessions for that account. Staff recovery goes through the owner; owner recovery is manual through a trusted operator, **never authorized solely by a claimed email**.

The browser holds no readable bearer token. `apiRequest` uses relative `/api` paths, same-origin credentials, no-store responses and rejected redirects. Hashed opaque tokens back **persistent server sessions without time-based expiry**; new session documents have no `expires_at`. Cookies request a **400-day maximum age**, renewed on every authenticated request, and remain **HttpOnly, SameSite=Strict**, Secure in production. Browsers can delete cookies, private mode can discard them, and clearing site data can require sign-in; browser storage is not guaranteed indefinitely. Existing still-valid legacy sessions upgrade automatically without resetting their original sign-in time; expired sessions are never revived. LocalStorage holds only the boolean **`dsa-session-present`** hint. The old **`niss-auth`** token store is discarded, not migrated. A hint is not authorization.

Profile checks run every 30 seconds and on focus. Inactive/gated accounts cannot enter operational routes; server authorization remains authoritative. Successful logout invalidates the server session and clears hint/cache; failed logout does not pretend to succeed. Password resets, role changes and deactivation still invalidate target sessions. Cross-tab session-hint changes return the tab to sign-in. **Sign out when leaving a shared office computer**; closing a tab is not logout and there is no general server session timeout to rely on.

## Data and workflows

- `GET /api/workspace` returns a server-filtered MongoDB snapshot. Owners/office receive company records; technicians receive assigned tickets and related customers/connections, plus same-company profile summaries and outages. Events/images require ticket access. UI filters are not tenant authorization.
- **Assigned technicians** is a checkbox group in create/edit forms for office/owner. Select multiple active technicians or clear all to unassign (maximum 50). Lists, details and CSV show all names; the technician filter matches any assignee. Legacy scalar/null assignments remain readable. Inactive historical assignments are displayed but cannot be newly selected. Technicians cannot change assignments; each selected technician can work on the shared ticket, with version conflicts preventing stale overwrites.
- Server-authenticated membership supplies company IDs, not create payloads. Query scopes use mode, company, user and role; access/session changes cancel/remove old scopes and remount workspace state. Inactive query data is not retained or persisted across workspaces.
- Workspace/activity normally refresh every **30 seconds**, not realtime. Ordinary refresh failures preserve last-loaded data with a warning; access/membership errors gate the workspace. The API loads all authorized records; ten-row table pages and search/report filters are local. Server-side pagination/search is needed as history grows.
- Updates submit the displayed ticket version. A **409** conflict preserves the draft for explicit reload/reconciliation. Creation keeps one UUID: definite validation/permission errors allow correction; uncertain/network/server results freeze the submitted draft for identical retry. Check saved records before creating another complaint.
- Office/owner can resolve unassigned phone fixes, close only resolved tickets and reopen resolved/closed tickets. Reopening clears current resolution while preserving old values in activity and rechecks active assignment. Technicians cannot close/reopen and may only add notes to assigned resolved/closed history. Each transition into a waiting state needs a reason in **Add a note**.
- Restoring outages does not close tickets. Dates display/edit in **Asia/Kolkata**, explicitly UTC+05:30. Ticket references use `DSA-0001` style with **per-company** numbering.
- Customer creation atomically includes the first connection and returns its ID. CSV imports are sequential, previewed/validated and never automatically retried. Headers: `full_name,phone,address,area,provider_id,account_number,network_node`; optional network-node cells may be blank. Provider IDs are lowercase; formula-like export cells are escaped. Reconcile uncertain imports before resubmitting.
- Customer editing/additional-connection UI, customer portal, billing, offline sync, automated messaging and provider API integration are not included.

## Reports and owner-only Performance

**Reports** (`/reports`) is available to owners and office staff as an **aggregate-only** operational overview. It contains no individual employee metrics. Dates select tickets by their **created date in Asia/Kolkata (IST)**, inclusive of both endpoints; cards, status distribution and provider workload show the **current state of that cohort**, not actions performed during those dates. Open excludes resolved/closed; **Awaiting feedback / resolved** includes every resolved ticket pending closure, even with saved feedback, and is separate from Closed.

- All time is the default; Last 7/30/90 days or custom dates can be selected. A bounded range requires both dates, ordered and at most **366 inclusive days**.
- Provider (including **No connection**) and priority filters apply to cards, charts, equivalent tables and ticket CSV alike. Provider workload counts open tickets; the trend counts tickets created by IST day.
- Recharts supplies bar/line charts, with a **Charts / Tables** toggle and exact-value tables accessible below charts. Exports contain the filtered tickets, preserve free-text feedback and unlinked records, and escape spreadsheet formulas. With no filters, all loaded accessible tickets are exported.

**Performance** (`/performance`) has owner-only navigation and route/query gates. Office staff and technicians do not mount its query; the server independently denies non-owners at `GET /api/reports/performance?from=YYYY-MM-DD&to=YYYY-MM-DD`. The report is scoped to the owner's company.

- Activity defaults to the last 30 days; presets/custom dates require **Apply dates**. Both endpoints are inclusive IST dates, with a maximum of **366 days**. Draft dates do not change the applied query or export.
- **Created, resolved, closed and feedback recorded** count unique tickets per **audit actor**, per metric, within the applied period—not the current assignee. Repeat actions on one ticket count once for that actor/metric; totals across people can overlap. Feedback recorded means a changed, nonblank feedback value in an audit, not positive feedback.
- **Median elapsed hours** measures creation to the actor's latest qualifying resolution per ticket within the period, then takes the median of valid durations. It includes provider/customer waits and all other elapsed time, **not actual labor time**. Missing duration history is `null`, rendered **No history**, never fabricated as zero or inferred from current ticket status.
- **Open assigned now**, **Overdue assigned now** and **Awaiting feedback now** are a current **all-history assignment snapshot**, independent of the activity date filter. Open excludes resolved/closed; overdue is open past its due time; awaiting feedback is resolved but not closed, even with feedback already saved. The snapshot generation timestamp is shown separately.
- A shared ticket counts once in each assigned employee's workload, so employee totals can exceed distinct ticket totals. Resolution activity credits the actual audit actor, not all assignees; notes document other technicians' contributions without inventing resolution activity.
- All company staff, including owners, inactive accounts and zero-activity accounts, appear by default. Role, active/inactive account, name search and employee selection filter the displayed rows and performance CSV. Table view is the default; Recharts count charts also provide a complete employee table including elapsed time. CSV includes the applied dates and snapshot timestamp; missing medians remain blank rather than zero.
- Queries are scoped by workspace and applied dates. Loading, unavailable, empty and error states are explicit; query errors hide cached performance data, including on background authentication/authorization failures. A manual refresh is available.

These are contextual operational records, **not employee scores or rankings**; no employee decisions or actions are automated. Roles, case difficulty and handoffs differ. **Customer feedback is free text, not sentiment analysis, a rating or verified satisfaction evidence**; neither feedback counts nor closure guarantees customer satisfaction.

## Images

Ticket detail supports **six JPEG/PNG/WebP images, 5 MB each**, uploaded one at a time. Browser checks supplement server decoding: **20 million pixels** maximum, resize within **2400 × 2400**, WebP re-encoding and EXIF/GPS stripping. Pending reservations count toward the server limit even when not displayed as ready images.

The repository accepts only expected same-origin image paths. Cloudinary assets are **authenticated**; the server proxies authorized bytes with private/no-store headers. **No public or signed Cloudinary URL reaches the browser**, and no paid token/cookie-based Cloudinary access feature is used. Technicians can view/upload/delete only on assigned tickets; other active ungated members must also have ticket access.

After an uncertain upload, refresh before retrying. Cleanup runs on startup/every **15 minutes**, reconciling deletions and pending uploads **older than one hour**. Image delivery adds backend bandwidth; Cloudinary `private_download_url` may count bandwidth twice under its accounting. See [backend image operations](backend-setup.md#protected-ticket-images).

## Demo and branding

**Preview demo** uses fictional in-memory records, makes **no API calls**, and resets on refresh. Staff/password operations are simulations; images are disabled and never uploaded. Performance derives activity only from the in-memory audit events, not assignments. Seeded creation events are fictional; pre-existing resolved/closed demo tickets have no seeded resolution history, so historical resolutions and elapsed durations are not invented. Current assignment counts can therefore exist without historical resolution activity. It is a workflow preview, not a server authorization emulator.

DSA is the brand; actual company names appear in workspace/account context. NISS remains a provider alongside Jio, Airtel and BSNL. Lucide `Building2` and priority/navigation icons are decorative; labels provide accessible meaning. Branding does not establish identity or permissions.

## Verification and operations

Aggregate verification for the current changes is being handled by the main verification run; no new totals or pass claims are recorded here. Local tests are not production acceptance.

- `npm test`: current MongoDB, frontend and registration suites.
- `npm run check`: lint, current tests and production build.
- `npm run test:e2e`: Chromium demo/intercepted-API tests. [Playwright configuration](../playwright.config.ts) starts Vite on **4173**. Install Chromium with `npx playwright install chromium` if needed. Never use real credentials in browser test artifacts.

MongoDB/Cloudinary pings succeeded, but no live application account, business records or deployment were created. Production cookies/HTTPS, tenant denial, image authorization, recovery and backup restore need staging acceptance. All companies share quotas. Operators must keep **encrypted MongoDB dumps plus Cloudinary stored originals**, verify restores and maintain manual intake during outages. **CSV is not a backup.**