# Kirana Kart UI — Frontend

**Stack:** React 19 · TypeScript · Vite · Zustand · Axios · Tailwind CSS
**Auth:** JWT Bearer tokens with automatic refresh + OAuth social login

---

## Overview

The Kirana Kart UI is the admin dashboard for the governance control plane. It connects to two backend APIs:

- **Governance API** (`http://localhost:8001`) — Auth, users, taxonomy, KB, analytics, BI agent
- **Ingest API** (`http://localhost:8000`) — Ticket ingestion pipeline

---

## Quick Start

### Option A — Docker Compose (Recommended)

From the project root:

```bash
docker compose up --build -d
```

UI is available at `http://localhost:5173`

### Option B — Local Development

```bash
cd kirana_kart_ui/
npm install
npm run dev
```

Vite dev server starts on port 5173 by default. Set `PORT` env variable to use a different port.

### Environment Variables

The UI reads these at build time (Vite `VITE_*` prefix):

| Variable | Default | Description |
|---|---|---|
| `VITE_GOVERNANCE_API_URL` | `http://localhost:8001` | Governance backend URL |
| `VITE_INGEST_API_URL` | `http://localhost:8000` | Ingest backend URL |

Set these in a `.env.local` file for local dev overrides (gitignored).

---

## Authentication

### Login Flow

1. Navigate to `/login`
2. Enter email + password **or** click a social login button (GitHub / Google / Microsoft)
3. On success: `access_token` (JWT, 60 min) + `refresh_token` (30 days) are stored in localStorage under the key `kk_auth`
4. All API requests include `Authorization: Bearer <access_token>`
5. On 401 response: Axios interceptor automatically POSTs to `/auth/refresh`, rotates the token, and retries the original request
6. If refresh fails: user is logged out and redirected to `/login`

### OAuth Flow

Clicking "Sign in with GitHub/Google/Microsoft" navigates the browser directly to the backend OAuth endpoint (e.g. `http://localhost:8001/auth/oauth/github`). The backend handles the full OAuth consent dance and redirects back to `/auth/callback?access_token=...&refresh_token=...`. The `OAuthCallbackPage` reads the tokens from the URL, fetches user profile via `/auth/me`, stores everything in the auth store, then redirects to the dashboard.

### Signup

New users can sign up at `/signup` with full name, email, and password. New accounts automatically receive **view-only access** on all modules. An admin can grant additional permissions from the Users page.

---

## Access Control

### Permission Model

Every user has per-module `{ view, edit, admin }` permissions stored in the JWT and in Zustand:

```typescript
interface UserPermissions { view: boolean; edit: boolean; admin: boolean }
interface User {
  id: number
  email: string
  full_name: string
  avatar_url?: string | null
  is_super_admin: boolean
  permissions: Record<string, UserPermissions>  // keyed by module name
}
```

`is_super_admin = true` bypasses all permission checks.

### Modules

| Module Key | Dashboard Section | Default access for new users |
|---|---|---|
| `dashboard` | Overview / home | ✅ view granted |
| `tickets` | Ticket queue + resolution | ✅ view granted |
| `taxonomy` | Issue code hierarchy | ✅ view granted |
| `knowledgeBase` | KB document management | ✅ view granted |
| `policy` | Compiled policy versions | ✅ view granted |
| `customers` | Customer records | ✅ view granted |
| `analytics` | Reports + charts | ✅ view granted |
| `system` | System health · vector jobs · audit logs · model registry · **channel integrations** | ✅ view granted |
| `biAgent` | Natural language SQL | ✅ view granted |
| `sandbox` | Testing tools | ✅ view granted |
| `cardinal` | **Pipeline observability, schedulers & registry CRUD** — 7-tab module: 5-phase stats, LLM execution traces, audit log, reprocess tool, beat schedule management, Action Registry (full CRUD for `master_action_codes`), Response Templates (full CRUD for `response_templates`) | ❌ **denied** — super-admin must grant |
| `qaAgent` | **QA Agent** — hybrid Python + LLM quality-assurance evaluations with SSE streaming | ✅ view granted |

### Checking Permissions in Components

```typescript
import { hasPermission, canView } from '@/lib/access'
import { useAuthStore } from '@/stores/auth.store'

const user = useAuthStore((s) => s.user)

// Check specific permission
if (hasPermission(user, 'taxonomy', 'edit')) { /* ... */ }

// Check view access (shorthand)
if (canView(user, 'knowledgeBase')) { /* ... */ }
```

### Route Guards

```typescript
// AuthGuard — redirects to /login if user === null
// AccessGuard — checks hasPermission(user, module, permission)
protect(SomePage, 'taxonomy', 'view')   // requires taxonomy.view
protect(UserManagementPage, 'system', 'admin')  // requires system.admin
```

---

## Project Structure

```
kirana_kart_ui/
├── public/
├── src/
│   ├── api/
│   │   ├── interceptors.ts           # Bearer token injection + 401→refresh→retry
│   │   ├── governance/
│   │   │   ├── auth.api.ts           # login, signup, refresh, logout, me
│   │   │   ├── users.api.ts          # user list + permission management
│   │   │   ├── taxonomy.api.ts       # taxonomy CRUD + versions
│   │   │   ├── tickets.api.ts
│   │   │   ├── customers.api.ts
│   │   │   ├── analytics.api.ts
│   │   │   ├── integrations.api.ts   # channel integrations CRUD + test + sync
│   │   │   ├── cardinal.api.ts       # cardinal pipeline + schedule + action registry + templates CRUD
│   │   │   ├── kb.api.ts             # KB upload, versions, publish, rollback, rule registry
│   │   │   ├── compiler.api.ts       # compile, action-code list, extract-actions
│   │   │   ├── qa.api.ts             # QA Agent — sessions, ticket search, SSE evaluate, get evaluation
│   │   │   └── bi.api.ts
│   │   └── ingest/
│   │       └── ingest.api.ts
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx          # Root layout wrapper
│   │   │   ├── Sidebar.tsx           # Nav with module-based visibility
│   │   │   ├── AuthGuard.tsx         # Redirects to /login if not authenticated
│   │   │   └── AccessGuard.tsx       # Checks hasPermission(user, module, perm)
│   │   └── ui/                       # Shared UI primitives (buttons, badges, etc.)
│   │
│   ├── lib/
│   │   ├── access.ts                 # hasPermission(), canView(), AppModule, Permission types
│   │   └── constants.ts              # API URLs, module lists, app constants
│   │
│   ├── pages/
│   │   ├── auth/
│   │   │   ├── LoginPage.tsx         # Email+password + GitHub/Google/Microsoft buttons
│   │   │   ├── SignupPage.tsx        # Registration form
│   │   │   └── OAuthCallbackPage.tsx # Handles /auth/callback?access_token=...
│   │   ├── dashboard/
│   │   ├── tickets/
│   │   ├── taxonomy/
│   │   ├── knowledge-base/
│   │   │   ├── KBPage.tsx            # 5-tab Knowledge Base page
│   │   │   └── tabs/
│   │   │       ├── DocumentsTab.tsx      # Upload + edit draft documents
│   │   │       ├── PipelineTab.tsx       # Guided 5-step compile → vectorize → publish workflow
│   │   │       ├── VersionsTab.tsx       # Published versions + rollback
│   │   │       ├── ActionCodesTab.tsx    # Action code viewer + LLM extractor
│   │   │       └── RulesTab.tsx          # Decision matrix — compiled rules per version
│   │   ├── customers/
│   │   ├── analytics/
│   │   ├── bi/
│   │   ├── system/
│   │   │   ├── SystemPage.tsx        # 5-tab admin: Health · Vector Jobs · Audit · Models · Integrations
│   │   │   └── IntegrationsPanel.tsx # Channel integrations UI (see below)
│   │   ├── cardinal/
│   │   │   ├── CardinalPage.tsx      # 7-tab page (Pipeline Overview · Phase Analysis · LLM Execution · Operations · Schedulers · Action Registry · Templates)
│   │   │   └── tabs/
│   │   │       ├── OverviewTab.tsx       # StatCards + TrendLineChart + PieDonutCharts (30s auto-refresh)
│   │   │       ├── PhaseAnalysisTab.tsx  # Per-LLM-stage cards + BarMetricChart error rate comparison
│   │   │       ├── ExecutionTab.tsx      # Paginated table + slide-over trace drawer (all 4 LLM stages)
│   │   │       ├── OperationsTab.tsx     # Audit log (30s refresh) + reprocess ticket tool (admin-only)
│   │   │       ├── SchedulersTab.tsx     # Beat schedule table — ON/OFF toggle, inline edit, Run Now
│   │   │       ├── ActionRegistryTab.tsx # Full CRUD for master_action_codes (view all, write requires admin)
│   │   │       └── TemplatesTab.tsx      # Full CRUD for response_templates with expandable variant rows
│   │   ├── agents/
│   │   │   └── QAAgentPage.tsx       # QA Agent — session sidebar, TicketListPanel (auto-loads 30 tickets),
│   │   │                             #   SSE evaluation viewer (Python check cards + LLM parameter cards)
│   │   └── users/
│   │       └── UserManagementPage.tsx # User table + per-module permission editor
│   │
│   ├── router/
│   │   └── index.tsx                 # React Router v6 routes + protect() helper
│   │
│   ├── stores/
│   │   └── auth.store.ts             # Zustand store (persisted as 'kk_auth')
│   │
│   └── types/
│       ├── auth.types.ts             # Re-exports from auth.store
│       ├── integration.types.ts      # Integration, IntegrationType, SyncStatus
│       ├── cardinal.types.ts         # CardinalOverview, PhaseStats, ExecutionSummary, ExecutionDetail, BeatSchedule, ActionCodeEntry, ActionCodePayload, ResponseTemplate, TemplatePayload
│       ├── kb.types.ts               # KBUpload, KBVersion, ActionCode, RuleEntry, ExtractActionsResult
│       └── qa.types.ts               # QASession, QAEvaluation, QATicketResult, QAPythonFinding, SSE event types
│
├── index.html
├── vite.config.ts                    # Vite config (uses process.env.PORT)
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

---

## Key Files

### `src/stores/auth.store.ts`

Zustand store persisted to `localStorage` key `kk_auth`:

```typescript
const useAuthStore = create<AuthStore>()(persist((set) => ({
  accessToken: null,
  refreshToken: null,
  user: null,
  setAuth: (accessToken, refreshToken, user) => set({ accessToken, refreshToken, user }),
  setAccessToken: (accessToken) => set({ accessToken }),
  logout: () => set({ accessToken: null, refreshToken: null, user: null }),
}), { name: 'kk_auth' }))
```

### `src/api/interceptors.ts`

Axios request interceptor injects `Authorization: Bearer <token>`. Response interceptor catches 401s:
- If not already refreshing: calls `/auth/refresh`, updates `accessToken`, retries
- If already refreshing: queues the request until refresh completes
- If refresh fails: calls `logout()` and redirects to `/login`

### `src/lib/access.ts`

```typescript
export type AppModule = 'dashboard' | 'tickets' | 'taxonomy' | 'knowledgeBase' |
  'policy' | 'customers' | 'analytics' | 'system' | 'biAgent' | 'sandbox' | 'cardinal' | 'qaAgent'
export type Permission = 'view' | 'edit' | 'admin'

export function hasPermission(user: User | null, module: AppModule, perm: Permission): boolean
export function canView(user: User | null, module: AppModule): boolean
```

### `src/router/index.tsx`

```typescript
// Public routes
/login          → LoginPage
/signup         → SignupPage
/auth/callback  → OAuthCallbackPage

// Protected routes (inside AuthGuard)
/dashboard      → protect(DashboardPage, 'dashboard', 'view')
/tickets        → protect(TicketsPage, 'tickets', 'view')
/taxonomy       → protect(TaxonomyPage, 'taxonomy', 'view')
/kb             → protect(KBPage, 'knowledgeBase', 'view')
/cardinal       → protect(CardinalPage, 'cardinal')          // default-deny
/cardinal/*     → protect(CardinalPage, 'cardinal')
/qa-agent       → protect(QAAgentPage, 'qaAgent', 'view')    // view granted to all new users
/users          → protect(UserManagementPage, 'system', 'admin')
// etc.
```

### `src/pages/system/IntegrationsPanel.tsx`

Channel Integrations management page (inside the System Admin → Integrations tab). Requires `system.view` to see, `system.admin` to create / edit / delete.

Features:
- **Type overview cards** — Gmail · Outlook · SMTP/IMAP · API Key, each showing active/total count. Click to open the "Add Integration" modal pre-set to that type.
- **Integration table** — name, type badge, org/module, active toggle, sync status pill (idle / running / ok / error with tooltip for error message), last synced timestamp, action buttons.
- **Add/Edit modal** — type-specific form fields (see below). All sensitive fields (tokens, passwords) use `type="password"` inputs.
- **Test Connection** — calls `POST /integrations/{id}/test` and shows inline success/error result.
- **Sync Now** — calls `POST /integrations/{id}/sync`, triggers background poll, auto-refreshes table after 2 seconds.
- **API key reveal-once flow** — on create of `api` type, the response contains the generated key; the modal switches to a "Copy now — it won't be shown again" screen before closing.
- **Delete confirmation** — warns about API key revocation for `api` type integrations.

**Type-specific config fields:**

| Type | Fields |
|------|--------|
| Gmail | Email address, Client ID, Client Secret, Access Token, Refresh Token, Folder/Label, Poll interval, Mark as read toggle |
| Outlook | Email address, Tenant ID, Client ID, Client Secret, Folder, Poll interval, Mark as read toggle |
| SMTP/IMAP | Email address, IMAP host, IMAP port, Username, Password, Folder, Poll interval, Use SSL toggle, Mark as read toggle |
| API | Description (key auto-generated on save; ingest URL shown for copy) |

### `src/pages/cardinal/CardinalPage.tsx` + `tabs/`

Cardinal Intelligence page (requires `cardinal.view` — default-deny for new users). Seven tabs:

| Tab | Component | Description |
|---|---|---|
| Pipeline Overview | `OverviewTab.tsx` | 6 StatCards (today/7d counts, auto-resolution %, dedup %, avg latency, phase failures), 14-day volume trend line chart, ticket source + channel pie charts. Auto-refreshes every 30s. |
| Phase Analysis | `PhaseAnalysisTab.tsx` | One card per LLM stage (Classification → Evaluation → Validation → Dispatch) showing processed/passed/failed counts, success rate badge, avg latency, and top error messages (expandable). BarMetricChart compares error rates across all stages. |
| LLM Execution | `ExecutionTab.tsx` | Searchable, filterable paginated table of all ticket executions. Clicking a row opens a slide-over **trace drawer** showing the full 4-stage LLM chain outputs (llm_output_1/2/3 + summary), processing metrics, and audit events. |
| Operations | `OperationsTab.tsx` | Recent audit log table (auto-refreshes 30s). Reprocess Ticket input (admin-only, requires `cardinal.admin`) — 2-step confirmation before calling `POST /cardinal/reprocess/{ticket_id}`. |
| Schedulers | `SchedulersTab.tsx` | Table of all 5 Celery Beat periodic tasks. Columns: task name/description, schedule (inline-editable), ON/OFF toggle pill (optimistic update), last triggered timestamp, Run Now button. Toggle takes effect on next beat tick; interval edits show ⚠ restart required badge. All write actions require `cardinal.admin`. |
| Action Registry | `ActionRegistryTab.tsx` | Full CRUD table for `master_action_codes`. Columns: Code ID (monospace), Name, Description (truncated), FD Status, Refund/Escalate/Auto boolean icons. Add/Edit form has Switch toggles for boolean flags; Code ID is locked in edit mode. Delete shows ConfirmDialog warning about broken references. Write actions require `cardinal.admin`. |
| Templates | `TemplatesTab.tsx` | Full CRUD table for `response_templates`. Columns: template_ref, action_code_id badge, issue_l1/l2, variant count badge. Rows expand inline to show up to 5 variant text blocks. Add/Edit form includes action_code_id Select (loaded from action registry), issue_l1/l2 inputs, and 5 Textarea variant slots. Write actions require `cardinal.admin`. |

### `src/pages/users/UserManagementPage.tsx`

Admin page (requires `system.admin`) showing:
- User table with status badge, super admin badge, activate/deactivate toggle
- Click a user → side panel opens with all 10 modules
- Each module: View / Edit / Admin switches — saves via `PATCH /users/{id}/permissions`
- Changes take effect on the user's next login or token refresh

---

## Development Commands

```bash
# Start dev server (hot reload)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Type check
npx tsc --noEmit

# Lint
npm run lint
```

---

## Adding a New Module

1. Add the module key to `AppModule` in `src/lib/access.ts`
2. Add a nav item in `src/components/layout/Sidebar.tsx` with `module: 'yourModule'`
3. Create the page component in `src/pages/yourModule/`
4. Add a protected route in `src/router/index.tsx`
5. Update `ALL_MODULES` in `app/admin/services/auth_service.py`
6. New users will automatically receive `can_view = true` for the new module

**To make a module default-deny** (like `cardinal`):

7. Add the module key to `ADMIN_ONLY_MODULES` in `auth_service.py` — `assign_viewer_permissions()` will set `can_view = false` for it automatically
8. Super-admins still bypass all checks; regular users must be explicitly granted access via the Users page

---

## Troubleshooting

**Blank page after OAuth login**
`/auth/callback` couldn't find tokens in the URL. Check that `FRONTEND_URL` in the backend matches the URL where the frontend is running (including port).

**`401 Unauthorized` on all requests after login**
The `access_token` may be expired and refresh is failing. Open browser DevTools → Application → Local Storage → delete `kk_auth` → refresh the page to force a new login.

**CORS error in browser**
The governance backend restricts CORS to `FRONTEND_URL`. If the frontend is running on a different port than configured (e.g., a preview server instead of Docker), update `FRONTEND_URL` in `docker-compose.yml` and restart the governance container.

**Permission denied on a page you should have access to**
Permissions are embedded in the JWT. After an admin updates your permissions, you need to log out and log back in (or wait for the current token to expire and auto-refresh) for changes to take effect.

**`kk_auth` vs `kk_admin_token`**
The old authentication system stored a static API token under `kk_admin_token`. The new JWT system uses `kk_auth`. If you have an old token in localStorage, clear it: DevTools → Application → Local Storage → delete `kk_admin_token`.
