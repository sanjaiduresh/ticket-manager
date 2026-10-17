# MongoDB / Express / Cloudinary setup

Current runtime: [server/index.js](../server/index.js), [server/app.js](../server/app.js), MongoDB accounts/data and Cloudinary images. No SQL migrations, SMTP or email-confirmation service is needed.

MongoDB and Cloudinary pings succeeded. No deployment, live application account or business records were created. Supplied credentials are in the ignored server-local environment file, mode `600`. **Rotate the supplied database password and Cloudinary API secret**, update local/host settings privately and recheck connectivity. Do not print, commit or put credentials in browser variables.

## Operator prerequisites and environment

Use **Node 24 LTS** and transaction-capable MongoDB: Atlas, a replica set or a sharded cluster. Startup rejects standalone MongoDB and initializes indexes in the selected database, including tenant/account uniqueness, company/date audit lookups and session/rate-limit expiry indexes. The session TTL index remains for legacy documents with `expires_at`; new persistent sessions omit that field and are not expired by it. It does not seed owners or business records.

Create a dedicated Atlas database user with **least privilege only for the intended database**, including required collection/index operations; never cluster-admin access or permissions to unrelated applications. Allowlist only the backend outbound IPs and current local development public IP. Update them when they change; do not open all IPs as a shortcut. A host without predictable outbound addresses needs a reviewed networking solution before launch.

The office laptop only needs the app URL/login. A trusted operator configures personal infrastructure from an authorized personal device; workers do not need Atlas/Cloudinary dashboard logins, and office restrictions must not be bypassed.

Use [.env.example](../.env.example) as the template for ignored [.env.server.local](../.env.server.local), keeping mode `600`. `npm run dev:api` and `npm start` load that file; production settings belong in host secret/environment storage.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Required server-only connection URI for the intended database user. |
| `MONGODB_DB` | Default `dsa_service_desk`; letters, digits, underscore and hyphen only. Set explicitly to avoid selecting the wrong database. |
| `CLOUDINARY_URL` | Server-only Cloudinary configuration with API credentials. Required for images; absence allows text-only operation. |
| `APP_ORIGINS` | Comma-separated exact origins, no wildcard/path/trailing slash. Development defaults to `http://127.0.0.1:5173,http://localhost:5173`; production requires explicit HTTPS origins. |
| `PORT` | Default `3001`; use the host-provided port in production. Vite's development proxy targets `3001`. |
| `NODE_ENV` | Optional locally; **set `production` when hosted** for Secure cookies, production headers, external listening and built frontend serving. |
| `TRUST_PROXY` | Optional Express trusted-proxy configuration, false when unset. Use only verified proxy IP/subnet settings matching the host; do not blindly trust forwarded headers. |

No browser credentials or `VITE_` secrets are needed. Do not log request bodies, cookies, connection URIs or signed Cloudinary URLs. File permissions and Git ignore rules do not replace rotation.

## Local run and production deployment

Locally: `npm ci`, then `npm run dev`. Express runs on **3001** and Vite on **http://127.0.0.1:5173**. [Vite's proxy](../vite.config.ts) forwards `/api` to Express, preserving same-origin cookies. Changing the API port alone breaks the proxy. **`GET /api/health`** returns `{"ok":true}` after a MongoDB ping; it does not validate Cloudinary or full application readiness.

Production requires a **persistent Node backend service**, not static Cloudflare Pages alone. Serve built frontend and API on **one HTTPS origin**:

1. Select a Node web-service host and pin **Node 24**. A Render free Node web service is a possible option only after checking **current availability, commercial-use eligibility, quotas, sleep and provider terms**. Review Atlas/Cloudinary terms too; no permanent-free or uptime promise is made. No subscription/deployment was activated here.
2. Configure server variables privately; set `NODE_ENV=production`, explicit `MONGODB_DB`, exact HTTPS `APP_ORIGINS` and Atlas backend-IP allowlisting.
3. Install/build with **`npm ci` and `npm run build`**, then **`npm start`**. Ensure build dependencies are installed during the build phase. Built frontend assets are served **only when `NODE_ENV=production`**. Production listens on `0.0.0.0` and `PORT`; development listens on loopback.
4. Set health check `/api/health`. Verify HTTPS, Secure cookies, SPA deep links, permitted-origin writes and rejection of unexpected origins. Express supplies security/cache headers; static Cloudflare configuration is not a server substitute.
5. Rehearse accounts, tenant denial, password lifecycle, ticket/image workflows and backup restore with fictional staging records before real business use.

`npm run preview` previews assets, not the API. A sleeping host pauses periodic image cleanup until wake/restart and can delay requests. Maintain manual intake and do not activate billing automatically.

## Accounts, security and recovery

`POST /api/auth/register` accepts only `company_name`, `full_name`, `email`, `password`. One transaction creates a new independent company, active owner and staff audit; **201** returns `ok` and normalized `email`. Sign in separately afterward. **No SMTP, verification step, completion endpoint, setup code or owner-email allowlist. Email is an unverified identifier** (`email_verified` is false), not proof of mailbox control. Reconcile lost registration responses by checking sign-in/account state before resubmission.

- One company per account; normalized emails are unique across this database. Signup cannot join an existing company, promote staff or recover an owner. Roles are `owner`, `office`, `technician`, not infrastructure permissions.
- [Security helpers](../server/security.js) use **Argon2id** passwords (minimum 12 Unicode characters, maximum 256 UTF-8 bytes) and random 32-byte opaque tokens, with only token hashes stored in MongoDB. New sessions have **no server-side time expiry** and omit `expires_at`. Cookies request a **400-day maximum age**, refreshed on each authenticated request. Cookies remain HttpOnly and SameSite=Strict; production adds Secure and the `__Host-` prefix. There are no browser-readable bearer/JWT tokens.
- Still-valid legacy sessions are automatically upgraded by removing `expires_at` after authentication; expired, logged-out or otherwise invalid sessions are **not revived**. Upgrading does not reset `created_at` or bypass recent-login checks. Browser cookie limits/deletion, private mode and cleared site data can still require sign-in: this is not a guarantee of eternal browser storage. **Sign out on shared office computers**; closing the browser is not a reliable substitute for logout.
- Unsafe methods require exact allowed `Origin` and reject cross-site fetches. Strict validation, Helmet headers, no-store API responses and MongoDB-backed fixed-window rate limits supplement authentication; origin checks alone are not authorization.
- Server queries derive company from the authenticated user. Owners/office receive company operational records; technicians receive assigned tickets and related customers/connections, plus same-company profile summaries and outages. Events/images require ticket access. No cross-company application administrator exists.
- `assigned_to` supports multiple technicians: new writes store sorted, deduplicated UUID arrays (maximum 50 unique IDs, 100 raw entries). Legacy UUID/null input and stored records remain supported without a bulk migration. MongoDB equality matches either a legacy scalar or an array member with the existing index. Assignment changes and reopening validate every selected technician as active and in-company. Empty arrays mean unassigned; in-progress tickets require at least one technician. Removed technicians lose ticket/event/image access. Equivalent assignment sets do not create assignment-change audit entries.
- [Company writes](../server/database.js) use snapshot/majority MongoDB transactions and a per-company revision write to serialize mutations. Actor/session are re-read after taking the lock. References and assignments are tenant-checked. Ticket versions reject stale edits with **409**; ticket numbers are **per company**, not globally sequenced.
- Owner-only Team actions create office/technician staff, change roles/access and reset passwords. **Owner accounts cannot be mutated through Team.** Creation/reset sets the mandatory password gate; reset, role and active-status changes invalidate target sessions through `auth_version`.
- Own password change requires the **current session's sign-in to be less than 15 minutes old**. Otherwise sign out/in. This requirement protects that sensitive change only; it is **not a general session timeout**. Success clears the gate and revokes other sessions, retaining the current session. Logout invalidates its token before clearing the cookie. Password resets, role changes and deactivation continue to invalidate target sessions despite persistence. Revocation cannot erase downloaded records or retract already in-flight responses.
- Ticket/staff audits are server-generated and immutable **through application APIs**, not tamper-proof against database root or a privileged collection operator. Restrict credentials and keep backups separate.

**Recovery:** owners reset staff through Team and deliver temporary credentials privately. Forgotten owner passwords need **manual, reviewed operator recovery**, not a public reset API or email link. Independently establish identity and company authority using pre-established trusted evidence/contact channels, tied to the **exact existing company and user IDs**. A claimed or matching email is insufficient. Reconcile account/audit state, revoke sessions, use a correctly Argon2id-hashed temporary password with the password gate, and record a nonsecret recovery audit in a reviewed transaction. Do not move membership, promote a new signup or disable controls to recover access. No automated owner-recovery tool is supplied.

## API map and workflows

All routes are same-origin. Apart from health, registration/login and idempotent logout, requests require cookie authentication. Operational routes also require active, password-ungated access; own password change remains available while gated.

| Route | Use |
| --- | --- |
| `GET /api/auth/session`, `GET /api/profile` | Restore session/check own access. |
| `POST /api/auth/login`, `POST /api/auth/logout` | Start/end session. |
| `GET /api/workspace` | Authorized company dataset in a MongoDB snapshot. |
| `GET /api/reports/performance?from=YYYY-MM-DD&to=YYYY-MM-DD` | Owner-only, company-scoped audit activity and current assignment snapshot. |
| `POST /api/customers` | Atomic customer + first connection creation; returns connection `id`. |
| `POST /api/tickets` | Stable caller UUID; existing same-company UUID acknowledged without another insert. |
| `PATCH /api/tickets/:id` | `version`, `patch`, `note`; validated workflow and activity in one transaction. |
| `GET /api/tickets/:id/events` | Authorized timeline. |
| `POST /api/outages`, `POST /api/outages/:id/restore` | Office/owner outage operations, no automatic ticket closure. |
| `POST /api/staff` | `create`, `update`, `reset_password`, `change_password`. |

Waiting transitions require a note; resolving requires nonblank resolution. Office/owner may resolve phone fixes, close only resolved tickets and reopen. Closure also requires nonblank `customer_feedback`, recorded by office/owner after resolution, either saved separately or supplied with closure. Technician feedback writes are denied. Office staff must contact the customer themselves; the app records their response but does not make calls or verify its content. Feedback is read-only after closure. Reopening clears current resolution and feedback while retaining prior values and the recording staff member in activity history; a fresh resolution cannot reuse prior feedback. Legacy resolved tickets must collect feedback before closing; legacy closed tickets are not retroactively given fabricated feedback and still allow notes. Technicians update status/resolution or notes only on assigned tickets; resolved/closed history permits notes only. Inspect uncertain creates/uploads before retrying; do not blindly generate another ticket UUID.

## Reporting semantics and access

[Performance](../server/performance.js) requires an authenticated, active, password-ungated **owner**. Office staff and technicians receive **403**, regardless of frontend navigation. The endpoint rechecks owner role, company, active/password-gate state and `auth_version` in the same MongoDB snapshot used to read profiles, tickets and events. Company IDs come from authenticated membership, never query input. General **Reports** remains an owner/office **aggregate-only** view over the authorized workspace, without individual employee metrics; Performance has separate owner-only navigation/API.

The API accepts exactly `from` and `to` calendar dates (`YYYY-MM-DD`), ordered and at most **366 inclusive days**. The window starts at midnight on `from` in **Asia/Kolkata (IST, UTC+05:30)** and ends just before midnight after `to`. Both dates are required. It returns `from`, `to`, `generated_at` and `employees`, including all company staff by default (owners, inactive accounts and zero-activity accounts).

| Metric | Meaning |
| --- | --- |
| `created`, `resolved`, `closed`, `feedback_recorded` | Unique tickets per audit actor and metric within the date window. Creation events, transitions into resolved/closed and changed nonblank feedback establish activity. Repeated actions do not inflate that actor's count; different actors' counts can overlap. **Never attributed from today's assignee.** |
| `median_resolution_hours` | Median creation-to-resolution elapsed hours, using the actor's latest qualifying resolution per ticket in the window. Includes provider/customer waits and all elapsed time, **not labor time**. No valid duration history returns **`null`**, displayed as **No history**, not zero. |
| `open_assigned`, `overdue_assigned`, `awaiting_feedback_assigned` | Current **all-history** assignments, independent of the date window. Open excludes resolved/closed; overdue is open with due time before snapshot generation; awaiting feedback includes all resolved tickets pending closure, even with saved feedback. |

Invalid/unusable audit history does not establish activity; current status/assignment is not a substitute for missing history. These metrics provide context, **not scores, rankings or automated employee decisions**. Roles, case difficulty and handoffs differ. Feedback is **free text, not sentiment analysis or verified ratings/satisfaction**. Recording feedback or closing a ticket does not guarantee customer satisfaction.

A shared ticket contributes once to each assigned employee's current workload. Therefore employee workload totals may exceed the number of distinct tickets. Resolution activity remains attributed to the employee who recorded the transition, not automatically to every assignee.

General Reports uses an inclusive IST **ticket-created cohort** (All time or a bounded range up to 366 days), plus provider (including **No connection**) and priority filters. Status/provider-workload charts show current cohort state; the created-date trend is not employee activity. Recharts and equivalent tables share filters with ticket CSV, which preserves feedback/unlinked records and escapes spreadsheet formulas. Performance CSV follows applied dates and employee filters, retaining the separate snapshot timestamp and blank missing medians.

Demo reporting uses fictional in-memory audits only, with no API calls. Seeded creation events are fictional; no resolution history is fabricated for pre-existing resolved/closed demo tickets. It does not emulate server authorization. The live Performance API reads all company tickets for assignment context plus period events; its date cap does not bound all-history ticket volume.

## Protected ticket images

[Image handling](../server/images.js) and the [Cloudinary adapter](../server/cloudinary.js):

- `GET/POST /api/tickets/:id/images`, `GET /api/tickets/:id/images/:imageId/content`, `DELETE /api/tickets/:id/images/:imageId`. Each requires ticket access; technicians are restricted to assigned tickets. Upload one multipart `image` per request.
- **Six images per ticket**, including pending reservations; **5 MB per input**, JPEG/PNG/WebP only. Sharp decodes actual content, rejects unsupported/multipage input, limits decoding to **20 million pixels**, auto-orients, resizes within **2400 × 2400** without enlargement and re-encodes WebP with EXIF/GPS stripped. Output is also capped at 5 MB.
- Cloudinary upload uses **`type: authenticated`**. The backend obtains a short-lived signed `private_download_url` and returns authorized bytes, not a redirect. **No public/signed CDN or download URLs reach the browser**. Responses are private/no-store. No paid Cloudinary token/cookie-access feature is used.
- MongoDB reservations precede remote side effects; Cloudinary calls stay outside retryable MongoDB transactions. Cleanup runs at startup and every **15 minutes**, retries deletions and removes pending uploads **older than one hour**, never ready images. Unconfirmed uploads may consume a slot; inspect/refresh before retrying.
- Every image view consumes Cloudinary delivery plus additional backend bandwidth. `private_download_url` may count bandwidth **twice** in Cloudinary accounting. Check current quotas/accounting; no automatic paid upgrade is configured.

## Verification, backups and limits

Aggregate verification for the current changes is being handled by the main verification run. No new counts or pass claims are recorded here; local suites are not live-host acceptance.

- `npm test`: [MongoDB API](../tests/mongo-api.test.js), [frontend](../tests/frontend.test.ts), [registration](../tests/registration.test.ts). Mongo tests do not load live credentials or the server entrypoint.
- `npm run check`: lint, current tests and production build. `npm run test:e2e`: local browser tests.

Before launch, verify two-company isolation, technician reassignment, stale-session denial, password gates, concurrent ticket/staff writes, headers/origins, unauthorized image denial, cleanup and restores in isolated staging. Connectivity pings alone prove none of these.

All companies share database/storage/delivery/backend quotas. `/api/workspace` loads all authorized records; UI filtering/pagination is local. Add indexed server-side search/pagination as history grows; ten-row pages and 30-second polling are not indefinite scalability. Customer editing/additional connections are not exposed in the current UI/API.

Assign an operator to take **encrypted off-provider MongoDB dumps** at least each working day and before changes, including users/password hashes, tenant relations, counters and audits. Back up **Cloudinary stored originals** (sanitized WebP assets, not discarded pre-upload photos) and MongoDB mappings separately. Preserve recovery/environment configuration securely outside Git. Verify backup consistency for the chosen Atlas tier; do not assume automatic backups are included.

**Test restores** into an isolated database/image environment, including indexes, account recovery, tenant checks and image references; invalidate restored sessions before reopening. Backups contain all companies' sensitive data and must not become tenant exports. **CSV is not a backup.** Document acceptable loss since the last verified backup, retention duties and manual intake/reconciliation during outages. Do not delete audits automatically to stay within free quotas.