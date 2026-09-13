# Kirana Kart — Governance Control Plane (Backend)

**Version:** 4.0.0
**Stack:** FastAPI · PostgreSQL · Weaviate · OpenAI · Redis · Celery
**Python:** 3.12+
**Auth:** JWT (python-jose) + bcrypt (passlib) + OAuth 2.0

---

## What Is This?

The governance control plane is a **FastAPI backend** that manages the full lifecycle of business rules for a quick-commerce operation. It handles:

- **Authentication & RBAC** — JWT-based auth, per-user per-module permissions, OAuth via GitHub/Google/Microsoft
- **Taxonomy management** — Issue code hierarchy with draft → version → publish → rollback workflow
- **Knowledge base** — Raw policy document upload, LLM compilation into structured rules, vectorization
- **Ticket processing** — 5-phase ingest pipeline, 4-stage LLM resolution, Celery workers
- **BI Agent** — Natural language SQL queries over the read-only `bi_readonly` role
- **Channel Integrations** — Gmail, Outlook, SMTP/IMAP mailbox polling + API key management; emails auto-submitted as tickets into the Cardinal pipeline
- **Cardinal Intelligence** — Full observability over the Cardinal pipeline (phase stats, per-ticket LLM traces, audit log) + admin reprocess tool + Celery Beat scheduler management (enable/disable/trigger periodic tasks) + full CRUD for **Action Registry** (`master_action_codes`) and **Response Templates** (`response_templates`); access is default-deny for new users
- **QA Agent** — Hybrid quality-assurance evaluation engine: 12 deterministic Python checks (COPC, ISO 15838, Six Sigma, FinOps standards) + 10 LLM semantic parameters via gpt-4o, blended into a single score; results stream via SSE in real time
- **Observability** — Prometheus metrics, structured JSON logging, correlation IDs

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  FastAPI App  (port 8001)                    │
│                  app/admin/main.py                           │
└──────────────────────────┬──────────────────────────────────┘
                           │  Registers routers
     ┌─────────────────────┼──────────────────────────────────┐
     │                     │                                   │
     ▼                     ▼                                   ▼
┌─────────┐        ┌──────────────┐               ┌─────────────────┐
│  /auth  │        │  /taxonomy   │               │  /kb  /compiler │
│  /users │        │  /tickets    │               │  /vectorization │
│  /bi    │        │  /customers  │               │  /simulation    │
│  /system│        │  /analytics  │               │  /shadow        │
│  /integr│        │              │               │                 │
└─────────┘        └──────────────┘               └─────────────────┘
     │                                                     │
     ▼                                                     ▼
┌──────────────┐                              ┌──────────────────────┐
│  PostgreSQL  │                              │       Weaviate       │
│  kirana_kart │                              │  Vector search (KB)  │
└──────────────┘                              └──────────────────────┘
                   ┌──────────────┐
                   │     Redis    │
                   │  Celery / cache │
                   └──────────────┘
```

### Layer Directory Map

| Directory | Role |
|---|---|
| `app/admin` | Auth, taxonomy, user management, system |
| `app/l1_ingestion` | Raw document upload + KB registry |
| `app/l15_preprocessing` | KB bridge: 6-layer validation + compilation |
| `app/l2_cardinal` | 5-phase ticket ingest pipeline (+ GPS enrichment in `phase4_enricher.py`) |
| `app/l3_analytics` | Spike detection (HDBSCAN clustering), true FCR computation |
| `app/l4_agents` | Celery worker — 4-stage LLM resolution pipeline, async FCR checker, agent QA scorer |
| `app/l45_ml_platform` | Compiler, vectorization, simulation |
| `app/l5_intelligence` | Shadow policy testing |

### v4.0 Fixes & Additions

#### P1 — Refund Fraud & Policy Leakage
- **`_fetch_rules` fix** (`worker.py`): Removed `AND module_name = %s` filter that caused zero deterministic rules to be loaded for every ticket. Ticket `module` labels ("delivery", "quality") never matched rule `module_name` values ("Fraud & Abuse Intelligence", "Resolution Policy…"). All rules for the active policy version are now fetched and applied.
- **`policy_version` persisted** (`worker.py`): The `llm_output_3` INSERT now writes `policy_version` (from `fields["active_policy"]`) so every resolved ticket is traceable to the exact rule set that governed it.
- **GPS delivery enrichment** (`l2_cardinal/phase4_enricher.py`): Pulls `gps_lat`/`gps_lng` from `delivery_events` table and writes `gps_confirmed_delivery` boolean into enriched context. Stage 1 evaluator uses this to satisfy R-001/R-003 GPS-based delivery proof rules.
- **R-005 tier auto-approve** (`l4_agents/ecommerce/stage2_validator.py`): Gold and Platinum customers on their first claim for an order are automatically routed to `AUTO_RESOLVED` regardless of refund amount, without requiring Stage 2 escalation.
- **Agent bad-actor flagging** (`l4_agents/tasks.py`): New Celery task `flag_bad_actor_agents` queries `ticket_execution_summary` grouped by `agent_id`, flags agents with high policy-ineligible refund rates, and writes results to `agent_quality_flags` table.

#### P2 — Agent Quality
- **`agent_qa_scorer.py`** (`l4_agents/ecommerce/`): New module — canned response detector (TF-IDF similarity against `conversation_turns`), grammar error counter (spaCy), sentiment arc (per-conversation customer sentiment trajectory), and daily per-agent QA score aggregation.

#### P3 — Ticket Spike Root Cause
- **`l3_analytics/clustering_service.py`** (new): `SpikeDetector` computes per-15-min ticket volume vs rolling average and emits spike events. `RootCauseClustering` runs HDBSCAN over `llm_output_1` embeddings within spike windows and writes top clusters to `spike_reports` table.

#### P4 — True FCR
- **`l3_analytics/fcr_service.py`** (new): Queries `ticket_execution_summary` and `llm_output_1` to compute true re-contact rate per `customer_id × issue_type_l2`.
- **Async FCR checker** (`l4_agents/tasks.py`): 48h after `resolution_status = resolved`, checks whether the same customer re-contacted on the same `issue_type_l2` within the window and updates the `fcr` column.

#### Analytics Dashboard
- **Three new tabs** (`kirana_kart_ui/src/pages/analytics/AnalyticsPage.tsx`):
  - **True FCR** — summary cards, FCR by intent breakdown table, daily FCR trend chart
  - **Spike Reports** — spike cards with σ-above baseline, per-spike cluster breakdown tables
  - **Agent Quality** — coverage stats, resolved-filter selector, agent flags table, per-agent QA score table (canned ratio, grammar errors, avg QA score)
- Backend endpoints: `GET /analytics/fcr`, `GET /analytics/spikes`, `GET /analytics/agent-quality` added to `app/admin/routes/analytics.py`.
- Frontend API helpers added to `kirana_kart_ui/src/api/governance/analytics.api.ts`.

#### QA Agent
- **KB Evidence panel fix** (`app/admin/services/qa_agent_service.py`): `retrieve_kb_evidence` fallback path now queries `kb_runtime_config.active_version` instead of the non-existent `kb_versions` table. The KB Evidence panel now correctly loads rules from Weaviate for the active policy version.

#### CORS
- **Extended origins** (`app/admin/main.py`): Added ports 51000–51199 to `allow_origins` to accommodate Vite preview server which assigns non-standard ports.

---

## Quick Start

### Option A — Docker Compose (Recommended)

Everything runs via Docker from the project root:

```bash
cd ..  # project root (kirana_kart_final/)
docker compose up --build -d
```

Governance API is available at `http://localhost:8001`.

Default super-admin: `admin@kirana.local` / `REDACTED`

### Option B — Local Development

```bash
cd kirana_kart/
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Edit .env with real values
cp .env .env.local

# Start server
uvicorn app.admin.main:app --reload --host 0.0.0.0 --port 8001
```

---

## Authentication

### How It Works

1. **Sign up** `POST /auth/signup` → user created with view-only access on all modules
2. **Log in** `POST /auth/login` → returns `access_token` (JWT, 60 min) + `refresh_token` (30 days)
3. All protected endpoints require `Authorization: Bearer <access_token>`
4. On 401, client POSTs `POST /auth/refresh` to rotate tokens
5. **Log out** `POST /auth/logout` invalidates the refresh token server-side

### OAuth Flow

OAuth is handled entirely by the backend:

1. Frontend navigates browser to `GET /auth/oauth/{provider}`
2. Backend redirects user to GitHub / Google / Microsoft consent screen
3. Provider redirects to `GET /auth/oauth/{provider}/callback`
4. Backend exchanges code for user info, upserts user, issues JWT
5. Backend redirects to `{FRONTEND_URL}/auth/callback?access_token=...&refresh_token=...`

End users only see the provider's familiar consent screen — no credentials stored in Kirana Kart.

### Permission Model

Each user has per-module `{can_view, can_edit, can_admin}` booleans:

| Module | Routes | Default `can_view` for new users |
|---|---|---|
| `dashboard` | Overview stats | ✅ granted |
| `tickets` | Ticket list + resolution | ✅ granted |
| `taxonomy` | Issue code hierarchy | ✅ granted |
| `knowledgeBase` | KB upload + publish | ✅ granted |
| `policy` | Compiled rule versions | ✅ granted |
| `customers` | Customer records | ✅ granted |
| `analytics` | Reports + BI agent | ✅ granted |
| `system` | Server status + user management | ✅ granted |
| `biAgent` | Natural language SQL | ✅ granted |
| `sandbox` | Testing sandbox | ✅ granted |
| `cardinal` | Pipeline observability + reprocess | ❌ **denied** (admin must grant) |
| `qaAgent` | QA Agent — hybrid Python + LLM evaluation | ✅ granted |

`is_super_admin = true` bypasses all permission checks.

New users via signup or OAuth get `can_view = true` on all modules **except** `cardinal`, which is in `ADMIN_ONLY_MODULES` and requires explicit super-admin grant.

---

## Database Schema

The application uses the `kirana_kart` schema in the `orgintelligence` PostgreSQL database.

### Auth Tables (auto-created on startup)

```sql
-- Users (replaces legacy admin_users table)
kirana_kart.users
  id SERIAL PK, email VARCHAR UNIQUE, full_name VARCHAR,
  password_hash VARCHAR (NULL for OAuth-only users),
  is_active BOOLEAN, is_super_admin BOOLEAN,
  oauth_provider VARCHAR, oauth_id VARCHAR, avatar_url TEXT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ

-- Per-user, per-module permissions
kirana_kart.user_permissions
  id SERIAL PK, user_id → users(id),
  module VARCHAR, can_view BOOL, can_edit BOOL, can_admin BOOL
  UNIQUE(user_id, module)

-- Refresh token store (for logout invalidation)
kirana_kart.refresh_tokens
  id SERIAL PK, user_id → users(id),
  token_hash VARCHAR UNIQUE, expires_at TIMESTAMPTZ
```

### BI Chat Tables (auto-created on startup)

```sql
kirana_kart.bi_chat_sessions
  id SERIAL PK, label VARCHAR, user_id INTEGER, created_at, updated_at

kirana_kart.bi_chat_messages
  id SERIAL PK, session_id → bi_chat_sessions(id) CASCADE,
  role VARCHAR, content TEXT, sql_query TEXT, created_at
```

### Integration Table (auto-created on startup)

```sql
kirana_kart.integrations
  id              SERIAL PK
  name            VARCHAR(200)
  type            VARCHAR(20) CHECK (type IN ('gmail','outlook','smtp','api'))
  org             VARCHAR(100)  DEFAULT 'default'
  business_line   VARCHAR(50)   DEFAULT 'ecommerce'
  module          VARCHAR(50)   DEFAULT 'delivery'
  is_active       BOOLEAN       DEFAULT FALSE
  config          JSONB         -- type-specific credentials (redacted on API responses)
  last_synced_at  TIMESTAMPTZ
  sync_status     VARCHAR(20)   CHECK ('idle','running','ok','error')
  sync_error      TEXT
  created_by      INTEGER → users(id)
  created_at / updated_at TIMESTAMPTZ
```

**Config JSONB shape per type:**

| Type | Config Fields |
|------|--------------|
| `gmail` | `email_address`, `client_id`, `client_secret`, `access_token`, `refresh_token`, `poll_interval_minutes`, `label_filter`, `mark_as_read` |
| `outlook` | `email_address`, `tenant_id`, `client_id`, `client_secret`, `poll_interval_minutes`, `folder`, `mark_as_read` |
| `smtp` | `email_address`, `imap_host`, `imap_port`, `username`, `password`, `use_ssl`, `poll_interval_minutes`, `folder`, `mark_as_read` |
| `api` | `api_key` (`kk_live_` + 64 hex), `description`, `ingest_url` |

### QA Agent Tables (auto-created on startup)

```sql
kirana_kart.qa_sessions
  id SERIAL PK, label VARCHAR, user_id INTEGER, created_at, updated_at

kirana_kart.qa_evaluations
  id SERIAL PK, session_id → qa_sessions(id) CASCADE,
  ticket_id INTEGER, overall_score NUMERIC(5,4), grade VARCHAR(1),
  python_qa_score NUMERIC(5,4), python_findings JSONB,  -- 12 check results
  llm_qa_score NUMERIC(5,4), llm_parameters JSONB,      -- 10 semantic scores
  summary TEXT, status VARCHAR, created_at
```

### Cardinal Scheduler Table (auto-created on startup)

```sql
kirana_kart.cardinal_beat_schedule
  id               SERIAL PK
  task_key         VARCHAR(100) UNIQUE NOT NULL   -- e.g. "poll-streams-every-5s"
  task_name        VARCHAR(200) NOT NULL          -- Celery task dotted path
  display_name     VARCHAR(200) NOT NULL          -- human-readable label
  description      TEXT
  schedule_type    VARCHAR(20) NOT NULL           -- 'interval' | 'crontab'
  interval_seconds INTEGER                        -- set for interval tasks
  cron_expression  VARCHAR(100)                   -- set for crontab tasks
  enabled          BOOLEAN NOT NULL DEFAULT true  -- checked by task guard at runtime
  last_triggered_at TIMESTAMPTZ                   -- updated on manual trigger
  updated_at       TIMESTAMPTZ DEFAULT NOW()
  updated_by       VARCHAR(200)                   -- email of last editor
```

Seeded with 5 default rows on governance startup (INSERT … ON CONFLICT DO NOTHING):

| task_key | display_name | schedule_type | interval |
|---|---|---|---|
| `poll-streams-every-5s` | Stream Poll | interval | 5s |
| `reclaim-idle-every-60s` | Idle Message Reclaim | interval | 60s |
| `refresh-risk-profiles-hourly` | Risk Profile Refresh | crontab | `0 * * * *` |
| `timeout-stuck-executions-every-10m` | Execution Timeout Check | interval | 600s |
| `purge-stale-dedup-keys-daily` | Dedup Key Purge | crontab | `0 2 * * *` |

### Business Tables

```sql
kirana_kart.issue_taxonomy          -- Live taxonomy nodes
kirana_kart.taxonomy_drafts         -- Taxonomy draft edits
kirana_kart.issue_taxonomy_versions -- Immutable taxonomy snapshots
kirana_kart.taxonomy_runtime_config -- Active version pointer
kirana_kart.issue_taxonomy_audit    -- Change audit log
kirana_kart.vector_jobs             -- Taxonomy vectorization queue
kirana_kart.kb_raw_uploads          -- Raw policy document uploads
kirana_kart.knowledge_base_versions -- Published KB snapshots
kirana_kart.kb_runtime_config       -- Active + shadow KB pointers
kirana_kart.kb_vector_jobs          -- KB vectorization queue
kirana_kart.rule_registry           -- Compiled structured rules
kirana_kart.master_action_codes     -- Resolution action lookup (managed via Cardinal → Action Registry)
kirana_kart.response_templates      -- Response template library (template_ref, action_code_id, issue_l1/l2, template_v1..v5)
kirana_kart.policy_versions         -- Policy version metadata
kirana_kart.policy_shadow_results   -- Shadow vs active comparison
```

---

## Environment Variables

All variables are read via `app/config.py` (Pydantic `BaseSettings`).

### Required

| Variable | Description |
|---|---|
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port (default `5432`) |
| `DB_NAME` | Database name (`orgintelligence`) |
| `DB_USER` | DB user (`orguser`) |
| `DB_PASSWORD` | DB password |
| `DB_SCHEMA` | Schema name (`kirana_kart`) |
| `REDIS_URL` | Redis connection string |
| `LLM_API_BASE_URL` | OpenAI base URL |
| `LLM_API_KEY` | OpenAI API key |
| `JWT_SECRET_KEY` | Secret for signing JWTs (change in production!) |

### Auth & OAuth

| Variable | Description |
|---|---|
| `JWT_ACCESS_EXPIRE_MINUTES` | Access token TTL (default `60`) |
| `JWT_REFRESH_EXPIRE_DAYS` | Refresh token TTL (default `30`) |
| `BOOTSTRAP_ADMIN_EMAIL` | Super-admin email created on first startup |
| `BOOTSTRAP_ADMIN_PASSWORD` | Super-admin password (min 8 chars) |
| `BOOTSTRAP_ADMIN_NAME` | Super-admin display name |
| `OAUTH_REDIRECT_BASE_URL` | Base URL for OAuth callbacks (e.g. `http://localhost:8001`) |
| `FRONTEND_URL` | Frontend origin for post-OAuth redirect (e.g. `http://localhost:5173`) |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `MICROSOFT_CLIENT_ID` | Azure AD application (client) ID |
| `MICROSOFT_CLIENT_SECRET` | Azure AD client secret value |

### Optional

| Variable | Default | Description |
|---|---|---|
| `DB_POOL_SIZE` | `10` | SQLAlchemy connection pool size |
| `DB_MAX_OVERFLOW` | `20` | Max additional connections above pool |
| `WEAVIATE_HOST` | `weaviate` | Weaviate hostname |
| `WEAVIATE_HTTP_PORT` | `8080` | Weaviate HTTP port |
| `WEAVIATE_GRPC_PORT` | `50051` | Weaviate gRPC port |
| `EMBEDDING_MODEL` | `text-embedding-3-large` | OpenAI embedding model |
| `LOG_FORMAT` | `text` | `text` or `json` |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `PROMETHEUS_ENABLED` | `true` | Enable `/metrics` endpoint |
| `ADMIN_TOKEN` | — | Legacy static token (kept for ingest service compatibility) |
| `BI_DB_USER` | `bi_readonly` | Read-only DB user for BI Agent |
| `BI_DB_PASSWORD` | — | Read-only DB user password |

---

## API Reference

Interactive docs: `http://localhost:8001/docs`

### Authentication (`/auth`)

| Method | Endpoint | Auth Required | Description |
|---|---|---|---|
| POST | `/auth/signup` | No | Register with email + password → viewer access |
| POST | `/auth/login` | No | Email + password → JWT tokens |
| POST | `/auth/refresh` | No | Rotate refresh token → new access token |
| POST | `/auth/logout` | Bearer | Invalidate refresh token |
| GET | `/auth/me` | Bearer | Current user profile + permissions |
| GET | `/auth/oauth/github` | No | Redirect to GitHub consent |
| GET | `/auth/oauth/github/callback` | No | GitHub OAuth callback |
| GET | `/auth/oauth/google` | No | Redirect to Google consent |
| GET | `/auth/oauth/google/callback` | No | Google OAuth callback |
| GET | `/auth/oauth/microsoft` | No | Redirect to Microsoft consent |
| GET | `/auth/oauth/microsoft/callback` | No | Microsoft OAuth callback |

### User Management (`/users`)

Requires `system.admin` permission.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/users` | List all users |
| GET | `/users/{id}` | Get user + permissions |
| PATCH | `/users/{id}/permissions` | Update module permissions |
| PATCH | `/users/{id}/deactivate` | Deactivate user |
| PATCH | `/users/{id}/activate` | Re-activate user |
| DELETE | `/users/{id}` | Permanently delete user |

### Health & Status

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/health/worker` | Vector worker heartbeat |
| GET | `/system-status` | DB + Redis + Weaviate + worker |
| GET | `/metrics` | Prometheus metrics |

### Taxonomy (`/taxonomy`)

Requires `taxonomy.view` (GET) or `taxonomy.edit` / `taxonomy.admin` (mutations).

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/taxonomy/` | view | List active issues |
| GET | `/taxonomy/drafts` | view | List drafts |
| GET | `/taxonomy/versions` | view | List versions |
| GET | `/taxonomy/diff` | view | Diff two versions |
| GET | `/taxonomy/audit` | view | Audit log |
| POST | `/taxonomy/draft/save` | edit | Save draft |
| POST | `/taxonomy/add` | edit | Add issue |
| PUT | `/taxonomy/update` | edit | Update issue |
| POST | `/taxonomy/publish` | admin | Publish version |
| POST | `/taxonomy/rollback` | admin | Rollback to prior version |

### KB Registry (`/kb`)

Requires `knowledgeBase.*` permissions.

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| POST | `/kb/upload` | edit | Upload raw policy document |
| PUT | `/kb/update/{id}` | edit | Update draft upload |
| GET | `/kb/versions` | view | List published versions |
| POST | `/kb/publish` | admin | Publish policy version |
| POST | `/kb/rollback/{label}` | admin | Rollback to previous version |
| GET | `/kb/rule-registry/{version_label}` | view | All compiled rules for a version (joined with action codes) |

### Compiler, Vectorization, Simulation

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| POST | `/compiler/compile/{label}` | knowledgeBase.admin | LLM compile raw → rules |
| GET | `/compiler/action-codes` | knowledgeBase.view | List all master action codes |
| POST | `/compiler/extract-actions` | knowledgeBase.admin | LLM-extract action codes from uploaded KB markdown |
| POST | `/vectorization/run` | knowledgeBase.admin | Run pending vector jobs |
| GET | `/vectorization/status/{label}` | knowledgeBase.view | Vector job status |
| POST | `/simulation/run` | policy.admin | Compare two policy versions |

### QA Agent (`/qa-agent`)

All endpoints require `qaAgent.view`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/qa-agent/sessions` | List all QA sessions (newest first) |
| POST | `/qa-agent/sessions` | Create a new named session |
| DELETE | `/qa-agent/sessions/{id}` | Delete session and cascade-delete its evaluations |
| GET | `/qa-agent/tickets/search?limit=N` | Return N most-recent completed tickets (no filter required) |
| POST | `/qa-agent/evaluate` | **SSE stream** — runs 12 Python checks then 10 LLM parameters; saves result to `qa_evaluations` |
| GET | `/qa-agent/evaluations/{id}` | Fetch stored evaluation with full check/parameter breakdown |

**SSE event types emitted by `/qa-agent/evaluate`:**

| Event | Payload | Notes |
|---|---|---|
| `python_check` | `{name, passed, score, weight, details}` | Fires 12× — one per deterministic check |
| `python_summary` | `{python_score, checks_passed, checks_failed}` | After all 12 checks |
| `parameter` | `{name, score, reasoning}` | Fires 10× — one per LLM semantic parameter |
| `summary` | `{overall_score, grade, llm_score, python_score, summary}` | Blended score + grade |
| `done` | `{evaluation_id}` | Persisted — use `evaluation_id` to fetch full record |

**Score blending:** `overall_score = 0.35 × python_score + 0.65 × llm_score`
**Grades:** A ≥ 90% · B ≥ 75% · C ≥ 60% · D ≥ 45% · F < 45%

### Cardinal Intelligence (`/cardinal`)

All GETs require `cardinal.view`. Reprocess and scheduler mutations require `cardinal.admin`.
Access is **default-deny** — new users receive `can_view = false` and must be granted access by a super-admin.

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/cardinal/overview` | view | Pipeline summary: totals, auto-resolution %, avg processing time, volume trend |
| GET | `/cardinal/phase-stats` | view | Per-LLM-stage pass/fail/error-rate breakdown (Classification → Evaluation → Validation → Dispatch) |
| GET | `/cardinal/executions` | view | Paginated execution list with filters (source, status, module, date range, search) |
| GET | `/cardinal/executions/{ticket_id}` | view | Full execution trace — raw ticket + all LLM outputs + metrics + audit events |
| GET | `/cardinal/audit` | view | Paginated execution audit log |
| POST | `/cardinal/reprocess/{ticket_id}` | admin | Re-submit ticket to `http://ingest:8000/cardinal/ingest` |
| GET | `/cardinal/schedules` | view | List all 5 Celery Beat schedule rows |
| PATCH | `/cardinal/schedules/{task_key}` | admin | Update `enabled`, `interval_seconds`, or `cron_expression` |
| POST | `/cardinal/schedules/{task_key}/trigger` | admin | Fire the task immediately via Celery `send_task` + update `last_triggered_at` |
| POST | `/cardinal/schedules/{task_key}/reset` | admin | Restore original interval/cron + set `enabled = true` |
| GET | `/cardinal/action-registry` | view | List all master action codes |
| POST | `/cardinal/action-registry` | admin | Create a new action code |
| PUT | `/cardinal/action-registry/{id}` | admin | Update an action code by id |
| DELETE | `/cardinal/action-registry/{id}` | admin | Delete an action code by id |
| GET | `/cardinal/templates` | view | List all response templates |
| POST | `/cardinal/templates` | admin | Create a new response template |
| PUT | `/cardinal/templates/{id}` | admin | Update a response template by id |
| DELETE | `/cardinal/templates/{id}` | admin | Delete a response template by id |

### Channel Integrations (`/integrations`)

All reads require `system.view`. All mutations require `system.admin`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/integrations` | List all integrations (sensitive config fields redacted to `***`) |
| POST | `/integrations` | Create integration — for `api` type, generates and returns the key **once** |
| GET | `/integrations/{id}` | Get single integration (config redacted) |
| GET | `/integrations/{id}/config` | Full unredacted config (`system.admin` only) |
| PATCH | `/integrations/{id}` | Update name / org / module / config (config is merged, not replaced) |
| DELETE | `/integrations/{id}` | Delete integration; for `api` type also removes key from `admin_users` |
| POST | `/integrations/{id}/toggle` | Flip `is_active` |
| POST | `/integrations/{id}/test` | Test connectivity — returns `{success, message}` |
| POST | `/integrations/{id}/sync` | Trigger one manual poll cycle in background (email types only) |
| POST | `/integrations/generate-key` | Generate a standalone `kk_live_` key (caller stores it) |

**API key lifecycle:**
- Key format: `kk_live_` + `secrets.token_hex(32)` = 64-char hex string
- On create: key is inserted into `kirana_kart.admin_users` so Phase 3 `_verify_api_token()` accepts it with zero pipeline changes
- On delete: key is removed from `admin_users` — access revoked immediately
- Key is only shown in the HTTP response at creation time; subsequent GET requests redact it

---

## Policy Document Lifecycle

```
1. Author writes business rules in markdown/docx/pdf
         ↓
2. POST /kb/upload  (stores in kb_raw_uploads)
         ↓
3. POST /compiler/compile/{version_label}
   (LLM extracts structured rules → rule_registry + knowledge_base_versions)
         ↓
4. POST /simulation/run  (compare candidate vs baseline on sample tickets)
         ↓
5. POST /shadow/enable {"shadow_version": "v1.1.0"}
   (run shadow in production, capture divergence)
         ↓
6. GET /shadow/stats  (review change_rate_percent)
         ↓
7. POST /kb/publish {"version_label": "v1.1.0"}
   (atomic publish + vector job queued)
         ↓
8. Background worker vectorizes rules into Weaviate (10s poll, SKIP LOCKED)
         ↓
9. Active policy live — agents query Weaviate at resolution time
```

---

## Background Workers

### Vector Worker (daemon thread)
Polls for pending `kb_vector_jobs` every 10 seconds. Uses `FOR UPDATE SKIP LOCKED` for safe concurrent replicas. Embeds rule text via `text-embedding-3-large` (3072 dims) and upserts into Weaviate's `KBRule` class.

Monitor: `GET /health/worker` → `{ alive, last_heartbeat_s, jobs_processed }`

### Integration Poller (daemon thread)
Runs as a named daemon thread (`kirana-integration-poller`). Sweeps every 60 seconds for active email integrations (Gmail / Outlook / SMTP) whose `last_synced_at` is older than their configured `poll_interval_minutes`. For each due integration:

1. Authenticates with the mailbox (Google API / Microsoft Graph / IMAP)
2. Fetches unread / unseen messages
3. Maps each email to a `CardinalIngestRequest` and POSTs to `http://ingest:8000/cardinal/ingest`
4. Marks messages as read (if `mark_as_read` is set)
5. Updates `sync_status` (`ok` or `error`) and `last_synced_at`

**API integrations** (`type = 'api'`) have no poller — they generate a `kk_live_` key that external systems use directly as a Bearer token on the ingest endpoint.

**Gmail token refresh:** If the access token is expired, the poller refreshes it via Google's token endpoint and persists the new tokens back to `integrations.config` automatically.

### Celery Workers
Two separate services:
- `worker-poll`: reads `cardinal:dispatch` Redis streams, dispatches tasks to Celery
- `worker-celery`: executes `process_ticket` tasks (4-stage LLM pipeline) with concurrency=2

Queue: `cardinal`
Broker: `redis://redis:6379/1`
Result backend: `redis://redis:6379/1`

---

## Project Structure

```
kirana_kart/
├── requirements.txt              # Pinned Python dependencies
├── .env                          # Environment variables (never commit)
│
├── app/
│   ├── config.py                 # Pydantic BaseSettings (all env vars)
│   ├── metrics.py                # Prometheus metrics + OpenTelemetry
│   │
│   ├── middleware/
│   │   └── logging_middleware.py # JSON structured logging + correlation ID
│   │
│   ├── admin/                    # Governance control plane
│   │   ├── main.py               # FastAPI app, lifespan, middleware, startup
│   │   ├── db.py                 # SQLAlchemy engine + session factory
│   │   ├── redis_client.py       # Redis client (single-node or cluster)
│   │   ├── routes/
│   │   │   ├── auth.py           # Shim re-exporting from auth_service
│   │   │   ├── auth_routes.py    # /auth/* endpoints
│   │   │   ├── user_management.py # /users/* endpoints
│   │   │   ├── taxonomy.py       # /taxonomy/* endpoints
│   │   │   ├── tickets.py        # /tickets/* endpoints
│   │   │   ├── customers.py      # /customers/* endpoints
│   │   │   ├── analytics.py      # /analytics/* endpoints
│   │   │   ├── bi_agent.py       # /bi-agent/* endpoints + BI chat tables
│   │   │   ├── integrations.py   # /integrations/* endpoints (CRUD + test + toggle + sync)
│   │   │   ├── cardinal.py       # /cardinal/* endpoints (overview, phase-stats, executions, audit, reprocess, beat scheduler, action registry, templates CRUD)
│   │   │   ├── qa_agent.py       # /qa-agent/* endpoints (sessions, ticket search, SSE evaluate)
│   │   │   └── system.py         # /system/* endpoints
│   │   └── services/
│   │       ├── auth_service.py       # JWT, bcrypt, UserContext, require_permission()
│   │       ├── oauth_service.py      # GitHub / Google / Microsoft OAuth flows
│   │       ├── integration_service.py # DB setup, Gmail/Outlook/IMAP polling, poller daemon
│   │       ├── qa_agent_service.py   # QA session/evaluation DB ops, ensure_qa_tables()
│   │       ├── qa_python_evaluators.py # 12 deterministic COPC/ISO/Six Sigma check functions
│   │       ├── taxonomy_service.py
│   │       └── vector_service.py
│   │
│   ├── l1_ingestion/             # Raw document upload + KB registry
│   │   └── kb_registry/
│   │       ├── routes.py
│   │       ├── kb_registry_service.py
│   │       └── markdown_converter.py
│   │
│   ├── l2_cardinal/              # 5-phase ticket ingest pipeline
│   │   ├── pipeline.py
│   │   ├── phase1_validator.py   # 8 validation checks
│   │   ├── phase2_deduplicator.py
│   │   ├── phase3_handler.py
│   │   ├── phase4_enricher.py
│   │   └── phase5_dispatcher.py
│   │
│   ├── l4_agents/                # Celery worker — 4-stage LLM pipeline
│   │   ├── worker.py             # Stream poll loop + Celery app
│   │   └── tasks.py              # process_ticket task + 5 beat tasks (each guarded by _is_task_enabled())
│   │
│   ├── l45_ml_platform/          # Compiler + vectorization + simulation
│   │   ├── compiler/
│   │   ├── vectorization/
│   │   └── simulation/
│   │
│   └── l5_intelligence/          # Shadow policy testing
│       └── policy_shadow/
│
├── tests/                        # pytest unit tests
│   ├── conftest.py
│   ├── test_config.py
│   ├── test_phase1_validator.py
│   └── test_redis_client.py
│
└── scripts/
    ├── test_endpoints.py         # Full API integration runner
    ├── kb_compiler.py
    └── run_vectorization.py
```

---

## Running Tests

```bash
# Unit tests (no DB or Redis required)
pytest tests/ -v

# Integration test (server must be running)
python scripts/test_endpoints.py

# Weaviate connection smoke test
python test_weaviate.py
```

---

## OAuth App Setup

To enable social login, register OAuth apps once and set the credentials in `docker-compose.yml` or `.env`.

### GitHub
1. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Set **Homepage URL**: `http://localhost:8001`
3. Set **Authorization callback URL**: `http://localhost:8001/auth/oauth/github/callback`
4. Copy **Client ID** and **Client Secret** → set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`

### Google
1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create OAuth 2.0 Client ID
2. Application type: **Web application**
3. Add Authorized redirect URI: `http://localhost:8001/auth/oauth/google/callback`
4. Copy credentials → set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

### Microsoft
1. Go to [Azure Portal](https://portal.azure.com) → App registrations → New registration
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
3. Redirect URI: `http://localhost:8001/auth/oauth/microsoft/callback`
4. Certificates & secrets → New client secret → copy value → set `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`

---

## Troubleshooting

**`relation kirana_kart.users does not exist`**
Auth tables are created automatically on startup via `ensure_auth_tables()`. This error means the governance container failed to run startup. Check: `docker compose logs governance`.

**`bcrypt` / `passlib` version error**
`bcrypt` must be pinned `<4.0.0` to stay compatible with `passlib 1.7.x`. The `requirements.txt` already pins `bcrypt>=3.2.0,<4.0.0`.

**`401 Invalid email or password` for `admin@kirana.local`**
The `.local` TLD is a reserved domain not accepted by strict email validators. Auth routes use a custom `@field_validator` on `str` (not `EmailStr`) to allow it.

**OAuth callback shows error**
- Check that `OAUTH_REDIRECT_BASE_URL` matches the callback URL registered with the provider
- Check that `FRONTEND_URL` matches where the frontend is running
- For GitHub: verify the OAuth App is not suspended

**`LLM_API_KEY not found`**
The `.env` file is not loaded. Run from `kirana_kart/` directory or ensure the `env_file` block in `docker-compose.yml` is correct.

**Weaviate not ready**
Wait 10–15 seconds after `docker compose up -d`. Check: `curl http://localhost:8080/v1/meta`.

**Port 8001 conflict**
Another service is using port 8001. Update `docker-compose.yml` ports mapping: `"8002:8001"` and update `VITE_GOVERNANCE_API_URL` in the UI service.

---

## Production Notes

- **Rotate `JWT_SECRET_KEY`** — use a cryptographically random string (≥ 32 chars). Rotating it invalidates all existing tokens.
- **Change `BOOTSTRAP_ADMIN_PASSWORD`** before first deployment.
- **Set `LOG_FORMAT=json`** for structured log aggregation (Datadog, CloudWatch, etc.).
- **`REDIS_CLUSTER_NODES`** — set this instead of `REDIS_URL` for Redis Cluster mode (eliminates single-node SPOF).
- **Prune `refresh_tokens`** — expired tokens are not auto-deleted. Add a cron: `DELETE FROM kirana_kart.refresh_tokens WHERE expires_at < NOW();`
- **Prune `policy_shadow_results`** — accumulates indefinitely; archive or truncate periodically.
- **Celery concurrency** — `worker-celery` defaults to 2 workers. Scale with `--concurrency=N` or run multiple replicas.
- **Weaviate** — `KBRule` class uses delete-then-insert per `policy_version` — safe for re-vectorization. Back up `weaviate_data` volume in production.
- **Integration credentials** — `access_token`, `refresh_token`, `password`, `client_secret`, and `api_key` are stored as plain text in the `integrations.config` JSONB column. Use PostgreSQL column encryption or a secrets manager (AWS Secrets Manager, Vault) for production deployments.
- **Gmail token refresh** — the integration poller auto-refreshes expired Google access tokens and persists the new token to the DB. Ensure the OAuth app is not in "Testing" mode so tokens don't expire after 7 days.
- **Outlook permissions** — the app registration requires `Mail.Read` (for reading) and optionally `Mail.ReadWrite` (for marking as read). Admin consent must be granted in the Azure portal.
- **API key revocation** — deleting an integration via the UI or `DELETE /integrations/{id}` immediately removes the key from `admin_users`. In production (non-sandbox) mode, Phase 3 will reject the key on the next ingest request.
