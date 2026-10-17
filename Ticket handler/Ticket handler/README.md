# DSA Service Desk

Company-scoped internal ticket handling for NISS, Jio, Airtel and BSNL. **DSA is the app brand**; each workspace displays its company's actual name.

Current stack: **React + TypeScript + Vite + shadcn/ui**, **Express on Node 24**, **MongoDB** accounts/data, and **Cloudinary** protected ticket images.

## Status

- MongoDB and Cloudinary connectivity pings succeeded. Supplied credentials are stored in ignored [.env.server.local](.env.server.local) with mode `600`. **Rotate the supplied database password and Cloudinary API secret before launch.**
- No deployment, live application account or business records were created. Pings are not production acceptance.
- Aggregate verification for the current changes is being handled by the main verification run. No new test totals or hosted end-to-end acceptance are claimed here.

## Local development

1. Use **Node 24 LTS** and install dependencies with `npm ci`.
2. Configure server-only settings from [.env.example](.env.example): `MONGODB_URI`, `MONGODB_DB` (default `dsa_service_desk`), `CLOUDINARY_URL`, `APP_ORIGINS`, `PORT`, and optional `NODE_ENV`/`TRUST_PROXY`. See [backend setup](docs/backend-setup.md). Never put credentials in `VITE_` variables.
3. Run `npm run dev`. It starts Express on **3001** and Vite at **http://127.0.0.1:5173**. Vite proxies `/api` to Express, preserving same-origin cookies. Changing the API port also requires updating the proxy.
4. Choose **Preview demo** for fictional, in-memory records with no API calls; refresh resets it and images are disabled. For live access, choose **Register owner**, then sign in.

MongoDB requires Atlas or a replica set, not a standalone server. `GET /api/health` pings MongoDB; it does not check Cloudinary. Missing Cloudinary configuration permits text-only operation. `npm run preview` previews assets only, not the full backend.

## Accounts and features

- Registration immediately creates an independent company and owner. Enter company name, full name, email, password and confirmation, then sign in separately. **No SMTP, email verification, setup code or owner-email allowlist. Email is an unverified login identifier, not identity proof.**
- One company per login, globally unique normalized emails, no workspace switcher. Signup cannot join another company or recover an existing account.
- Owners create office/technician staff in **Team**, privately deliver temporary passwords and require an initial password change. Team cannot mutate owner accounts. Own password changes require the current session's sign-in to be less than **15 minutes** old; this protects that sensitive change, **not a general session timeout**. Success retains the current session and revokes the account's other sessions.
- Ticket assignment, search, scheduling, follow-ups, provider references, waiting reasons, activity history, version conflicts and safe UUID retries. Office/owner resolve phone fixes, close resolved tickets and reopen; technicians work on assigned tickets.
- **Multiple technicians per ticket:** office/owner select technicians using checkboxes when creating or editing a ticket. Each selected technician can access its details, notes and images and record allowed status changes. Removing a technician removes their ticket access. Existing single-technician tickets remain compatible. Shared workload counts once per assigned employee; resolution activity credits the actual audit actor, not everyone assigned.
- **Repair → customer feedback → closure:** technicians mark repairs Resolved with a resolution note. Office staff use **Awaiting feedback**, contact the customer, and record **Customer feedback** before closing. Feedback can be saved while still resolved. Reopen if the issue persists; reopening clears current feedback so the next repair requires a fresh customer follow-up. No automatic calls or messages are sent.
- Connections are optional when creating tickets. Leave **No connection (optional)** selected and record customer/contact details in the ticket description if needed. Unlinked tickets support assignment, notes, images and resolution; provider filters and outage linking require a connection. Linking an existing ticket to a connection later is not exposed in this version.
- Atomic customer + first connection creation, validated CSV imports, formula-safe exports, outages and workload reports. Outage restoration does not automatically close tickets.
- **Reports** is an owner/office aggregate operational overview, with no individual employee metrics. Recharts charts and equivalent tables share ticket-created IST date, provider (including **No connection**) and priority filters with the ticket CSV export. Cards show the current state of that created-date cohort, not work performed during the period; resolved/awaiting-feedback and closed are separate.
- **Performance** navigation and `GET /api/reports/performance?from=YYYY-MM-DD&to=YYYY-MM-DD` are **owner-only**. Activity counts unique tickets per audit actor and metric, never inferred from the current assignee. Current assignments are an all-history snapshot separate from period activity. See [report definitions](docs/frontend.md#reports-and-owner-only-performance).
- **Six JPEG/PNG/WebP images per ticket, 5 MB each**, re-encoded with metadata stripped and delivered as authorized API bytes, never public Cloudinary links.

Reporting date ranges are inclusive **Asia/Kolkata (IST)**, maximum **366 days**; general Reports also allows All time. Performance median elapsed hours runs from ticket creation to that actor's latest qualifying resolution per ticket in the period, **including provider/customer waits, not labor time**. Missing duration history is `null` (shown as **No history**), not zero. There are no employee scores, rankings or automated employee decisions. Customer feedback is free text, not sentiment analysis or a verified satisfaction/rating measure; counts do not guarantee satisfaction. Demo activity uses only fictional in-memory audit events and does not invent resolution history for pre-existing resolved/closed demo tickets.

Staff recovery goes through the company owner. **Owner recovery is manual through a trusted operator**, not an automated email reset; a claimed email alone never authorizes recovery. See [security and recovery](docs/backend-setup.md#accounts-security-and-recovery).

## Hosting without a subscription

The office laptop only needs the app URL and application login, **not personal Atlas, Cloudinary, Git or hosting-dashboard logins**. A trusted operator must configure infrastructure privately from an authorized personal device; do not bypass office restrictions.

Production needs a **persistent Node backend host**; static Cloudflare Pages alone cannot run this Express/MongoDB API. Host frontend and API together on **one HTTPS origin**: Node **24**, `npm ci`, `npm run build`, then `npm start` with **`NODE_ENV=production`**, server secrets and the exact HTTPS `APP_ORIGINS`. **`npm start` serves built frontend assets only in production mode.**

A Render free Node web service is one possible option, **subject to current availability, commercial-use eligibility, quotas, sleep and provider terms**. Review Atlas/Cloudinary allowances too. No subscription or deployment was activated here; no permanently free service or uptime is promised. Sleeping services delay requests and cleanup. See [deployment setup](docs/backend-setup.md#local-run-and-production-deployment).

## Verification and operations

- `npm test`: current MongoDB API and frontend/registration suites.
- `npm run check`: lint, current tests and production build.
- `npm run test:e2e`: local Chromium demo/mocked-API tests; install Chromium with `npx playwright install chromium` if needed.

Tenant access is server-filtered; company mutations are serialized in MongoDB transactions. Passwords use Argon2id; hashed opaque session tokens back **persistent sessions with no server-side time expiry** (`expires_at` is absent on new sessions). Browser cookies request a maximum age of **400 days**, refreshed on each authenticated request; browser deletion, private mode or cleared site data can still require sign-in. Storage is not guaranteed forever. Still-valid legacy sessions upgrade automatically; expired sessions are not revived. Cookies remain **HttpOnly, SameSite=Strict**, Secure in production. Logout, password resets, role changes and deactivation still invalidate access. **Sign out on shared office computers** rather than relying on a timeout. Audit history is immutable through application APIs, **not protected from database-root access**.

All companies share database, image storage and backend/bandwidth quotas. Image delivery adds backend bandwidth; Cloudinary `private_download_url` delivery may count bandwidth twice under its accounting. Monitor aggregate usage. Operators must retain **encrypted MongoDB dumps plus Cloudinary stored originals**, securely preserve recovery configuration and **verify restores**. CSV exports are not backups. Maintain manual intake during outages.

The API returns all authorized workspace records and the UI filters/paginates locally; this is not indefinitely scalable. There is no customer-editing or additional-connection UI, customer portal, billing, offline synchronization, automated messaging or provider API integration.

See [docs/frontend.md](docs/frontend.md) for architecture and [docs/backend-setup.md](docs/backend-setup.md) for security, images, deployment and backups.
