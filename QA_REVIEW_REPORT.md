# QA Review Report — Kirana Kart Full-Stack Platform

**Prepared by:** Quality Assurance
**Report Date:** 12 March 2026
**Addressed to:** Director / AVP of Technology
**Classification:** Internal — Confidential
**Review Scope:** End-to-End Software Quality Audit (Architecture · Security · Code · Testing · Observability · Deployment Readiness)

---

## Executive Summary

Kirana Kart is a production-grade, multi-service platform designed to automate the triage, enrichment, and resolution of customer support tickets using a four-stage LLM pipeline. The system comprises two FastAPI services (Ingest and Governance), a Celery worker fleet, Redis streams for priority dispatch, a PostgreSQL data store, a Weaviate vector database, and a React 19 frontend.

**Overall Assessment: CONDITIONAL PASS — Not Yet Production-Ready**

The platform demonstrates strong architectural thinking, a well-structured pipeline design, and a reasonable frontend foundation. However, **three critical security deficiencies** must be remediated before any production deployment, and test coverage requires significant expansion to meet enterprise quality standards. With focused remediation work, the platform has the maturity to pass a production readiness review.

| Domain | Rating | Status |
|--------|--------|--------|
| Architecture & Design | 8 / 10 | Pass |
| Code Quality & Standards | 7 / 10 | Pass with Observations |
| Security Posture | 4 / 10 | **Fail — Critical Issues** |
| Test Coverage & Quality | 5 / 10 | Conditional Pass |
| Observability & Monitoring | 7 / 10 | Pass |
| Deployment & Infrastructure | 6 / 10 | Conditional Pass |
| Frontend Quality | 7 / 10 | Pass |

---

## 1. System Overview

### 1.1 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     React UI (5173)                     │
│         Role-Gated · TanStack Query · Zustand           │
└────────────────┬────────────────┬───────────────────────┘
                 │                │
    ┌────────────▼──┐    ┌────────▼────────────┐
    │  Ingest Plane │    │  Governance Plane   │
    │  (Port 8000)  │    │  (Port 8001)        │
    │  main.py      │    │  app/admin/main.py  │
    └──────┬────────┘    └────────────────────┘
           │ Five-Phase Synchronous Pipeline
           │ Phase 1→2→3→4→5
           ▼
    ┌──────────────┐
    │  Redis 7     │  Streams: P1_CRITICAL / P2_HIGH / P3_STANDARD / P4_LOW
    │  (Port 6379) │  + Dedup Cache + Rate Limiting + Circuit Breaker Keys
    └──────┬───────┘
           │ Consumer Group: cardinal_workers
           ▼
    ┌──────────────┐
    │ Celery Worker│  4-Stage LLM Pipeline
    │              │  Stage 0: Classify (gpt-4o-mini)
    │              │  Stage 1: Evaluate (gpt-4.1)
    │              │  Stage 2: Validate (o3-mini)
    │              │  Stage 3: Respond  (gpt-4o)
    └──────┬───────┘
           │
    ┌──────▼───────┐    ┌──────────────────┐
    │  PostgreSQL  │    │  Weaviate 1.29.4  │
    │  (Port 5432) │    │  Vector DB (8080) │
    └──────────────┘    └──────────────────┘
```

### 1.2 Service Inventory

| Service | Technology | Port | Purpose |
|---------|-----------|------|---------|
| `ingest` | Python 3.12 / FastAPI / uvicorn | 8000 | Ticket ingestion endpoint |
| `governance` | Python 3.12 / FastAPI / uvicorn | 8001 | Admin control plane |
| `worker-celery` | Celery 5.4 / Redis | — | LLM processing pipeline |
| `worker-poll` | Python stream consumer | — | Redis stream dispatcher |
| `ui` | React 19 / Vite 7 / TypeScript | 5173 | Frontend dashboard |
| `postgres` | PostgreSQL 14 | 5432 | Primary data store |
| `redis` | Redis 7 | 6379 | Cache, streams, broker |
| `weaviate` | Weaviate 1.29.4 | 8080 / 50051 | Vector knowledge base |

---

## 2. Architecture & Design Assessment

### 2.1 Strengths

**Pipeline Design (Phase 1–5)**
The five-phase synchronous ingestion pipeline is well-conceived. Each phase has a clear, single responsibility: validate → normalise → deduplicate → verify/route → enrich → dispatch. The pipeline never raises uncaught exceptions; all failures are mapped to typed HTTP responses with appropriate status codes (202, 200, 401, 403, 422, 503). This is a sound design that is easy to trace, debug, and extend.

**Priority Queue Architecture**
The four-tier Redis stream design (`P1_CRITICAL → P4_LOW`) provides genuine dispatch priority control. This demonstrates production thinking — SLA-breach tickets do not compete in the same queue as low-priority backlog items.

**Worker Concurrency Model**
Celery with Redis as broker, separate priority queues, and exponential backoff retry is the correct architecture for unreliable LLM calls. The `FOR UPDATE SKIP LOCKED` pattern for atomic message claiming prevents double-processing.

**Database Connection Management**
SQLAlchemy QueuePool is correctly configured (pool_size=10, max_overflow=20, pool_timeout=30s, pool_recycle=3600s, pre_ping=True). The `get_db_session()` context manager handles auto-commit/rollback correctly.

**Redis Multi-Mode Support**
The redis client supports both single-node (dev) and cluster mode (prod) via `REDIS_CLUSTER_NODES`. The key-builder functions (`dedup_key`, `volume_key`, `circuit_key`, `cache_key`) are centralised and use consistent TTLs. This is a clean abstraction.

**Knowledge Base Lifecycle**
The KB pipeline (upload → markdown conversion → compilation → vectorisation via background jobs) is a well-layered design. The background worker with heartbeat, job status tracking, and the `kb_vector_jobs` table gives operational visibility.

**Frontend Architecture**
React 19 with lazy route-level code splitting, TanStack Query (60s staleTime), Zustand for auth/UI/toast state, and Radix UI for accessible primitives is a modern, solid stack. The dual Axios client design (separate `ingestClient`/`governanceClient` with per-client interceptors) is clean.

### 2.2 Design Concerns

**BUG-001 — Background Worker Not Suitable for Multi-Instance Governance Deployment**
> *Severity: Medium | Component: `app/admin/main.py`*

The governance plane starts a Python daemon thread as a vector job processor. The code itself acknowledges this: *"Production note: Should be migrated to Celery Beat scheduled task for multi-instance deployments."* Running multiple governance instances today would cause race conditions on `kb_vector_jobs`.

**Recommendation:** Migrate to Celery Beat before scaling the governance plane horizontally.

---

**BUG-002 — In-Memory Rate Limiting is Non-Distributed**
> *Severity: Medium | Component: `app/admin/routes/auth.py`*

The rate limiter stores `_request_log` in a process-local dict (100 req/60s per token). On restart, counters reset. With multiple instances or container restarts under load, this provides no real protection.

**Recommendation:** Migrate rate limiting state to Redis using a sliding window counter per token key.

---

**GAP-001 — CORS Wildcard in Both Services**
> *Severity: High (see Security section)*

Both the ingest and governance FastAPI apps are configured with `allow_origins=["*"]`. This is unacceptable for any non-development deployment.

---

**GAP-002 — No API Gateway / Unified Auth Layer**
The two services (8000, 8001) each implement their own auth logic independently. As the service count grows, this creates inconsistent enforcement. There is no API gateway, reverse proxy, or unified middleware enforcing auth, rate limiting, and logging at the edge.

**Recommendation:** Add nginx or a lightweight API gateway in front of both services in any environment beyond local dev.

---

## 3. Security Assessment

> This section covers the three most significant security findings. These represent **blockers for production deployment**.

### 3.1 CRITICAL — Credentials Committed in `.env` File

**Finding:** The file `kirana_kart/.env` contains production-grade secrets committed in plaintext:
- OpenAI API key (`sk-proj-...`)
- PostgreSQL password
- Freshdesk API key and domain

If this repository is or has been hosted on any VCS (GitHub, GitLab, Bitbucket), these credentials should be treated as compromised and must be rotated immediately regardless of any `.gitignore` settings.

**Risk:** Unauthorized access to OpenAI account (billing abuse), full database access, impersonation of Freshdesk webhooks.

**Required Action:**
1. Rotate all three credentials immediately.
2. Add `.env` to `.gitignore` (confirm it is not tracked in git history; if it is, use `git filter-repo`).
3. Move secrets to a managed secret store (AWS Secrets Manager, HashiCorp Vault, or Doppler for a simpler option).
4. In Docker Compose, use `secrets:` block or inject via environment at runtime — never bake secrets into image layers.

---

### 3.2 CRITICAL — CORS Allow-All Origins (`*`)

**Finding:** Both FastAPI apps configure:
```python
CORSMiddleware(allow_origins=["*"], allow_credentials=True, ...)
```

Combined with `allow_credentials=True`, this is explicitly [forbidden by the CORS spec](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS/Errors/CORSNotSupportingCredentials). Browsers will block it. More importantly, in production this exposes admin APIs to cross-origin requests from any domain.

**Required Action:**
- Dev: `allow_origins=["http://localhost:5173"]`
- Production: `allow_origins=["https://your-production-domain.com"]`
- Remove `allow_credentials=True` from the ingest service (no cookies are used there).

---

### 3.3 CRITICAL — Hardcoded Admin Tokens in Test and Compose Files

**Finding:** The Playwright E2E suite and `docker-compose.yml` both reference:
```
local_admin_token / viewer_test_token / editor_test_token
```

These are static, predictable strings. If the governance service is reachable on any network where these values are known, full admin access is trivially obtained.

**Required Action:**
- Generate cryptographically random tokens per deployment (e.g., `openssl rand -hex 32`).
- E2E tests must read tokens from environment variables, never hardcode defaults that match production-class values.
- Consider JWT or a proper session-based auth mechanism for the governance plane.

---

### 3.4 HIGH — Admin Token Stored in localStorage (XSS Risk)

**Finding:** `auth.store.ts` and `interceptors.ts` store and read the admin token from `localStorage`. Any XSS vulnerability anywhere in the frontend would allow token exfiltration.

**Recommendation:** Migrate to `httpOnly` cookies for token storage. The token becomes inaccessible to JavaScript and immune to XSS-based theft.

---

### 3.5 MEDIUM — No TLS on Database Connection

The default `DATABASE_URL` in `config.py` does not include `sslmode=require`. All database traffic in a non-localhost deployment would be transmitted in plaintext.

**Recommendation:** Add `?sslmode=require` (or `verify-full`) to `DATABASE_URL` in all non-development environments.

---

### 3.6 MEDIUM — Frontend-Only RBAC Enforcement

The `AccessGuard` component in the frontend prevents navigation to restricted routes, but if a role check is missed or bypassable in the frontend, there is risk of unauthorized API calls succeeding. Backend route handlers must also enforce role requirements independently.

**Recommendation:** Confirm that all governance API endpoints validate the role from the token on the server side — not only the frontend guard.

---

### 3.7 LOW — Injection Guard Coverage

The Phase 1 validator (`phase1_validator.py`) correctly detects SQL injection patterns in `description` and `subject` fields (confirmed in `test_phase1_validator.py`). This is good. However, it is not confirmed that the same guard applies to all freeform fields in the `payload` dict (e.g., `attachment_urls`, `order_id` fields before DB write).

**Recommendation:** Extend injection guard coverage to all string fields written to `fdraw` or passed to DB queries.

---

## 4. Code Quality Assessment

### 4.1 Backend (Python / FastAPI)

**Positives:**
- Clean separation of layers: `l1_ingestion`, `l2_cardinal`, `l4_agents`, `l45_ml_platform`, `l5_intelligence`, `admin`
- Pydantic schemas are used correctly at the ingestion boundary (`CardinalIngestRequest`, `FreshDeskPayload`, `DirectAPIPayload`)
- Schema constants (`VALID_CHANNELS`, `VALID_SOURCES`, etc.) are centralised in `schemas.py` — good practice
- `PipelineResponse` type union prevents bare exception propagation from the pipeline
- Structured JSON logging with `python-json-logger` is present
- `pytest.ini` configured with `asyncio_mode = auto` and warning suppression for known third-party noise

**Observations:**

**OBS-001 — Deprecated `get_connection()` Shim Still Present**
`app/admin/db.py` contains a `get_connection()` function marked as deprecated (bypasses the pool). It is still importable and could be called accidentally.

**Recommendation:** Remove the function or raise `DeprecationWarning` + add a comment pointing to `get_db_session()`.

---

**OBS-002 — `second_path4.md` in Backend Root**
The file `kirana_kart/second_path4.md` appears to be a developer scratch/design notes file. It should not be in a version-controlled backend service directory.

**Recommendation:** Move to a `/docs` directory or remove if no longer needed.

---

**OBS-003 — `test_weaviate.py` in Backend Root**
`kirana_kart/test_weaviate.py` is a standalone test/script in the project root, not under the `tests/` directory and not discovered by pytest. Its intent is unclear.

**Recommendation:** Either formalise it into `tests/` with proper fixtures or remove it.

---

**OBS-004 — `exports/` Directory Contains SQL Dump**
The README references `kirana_kart_full_export_20260304_143135.sql` as the database initialisation file. Committing database exports to version control is a data governance risk.

**Recommendation:** Do not commit SQL exports. Store schema migrations in Alembic; seed data in a dedicated migration script; database backups in S3/GCS with encryption at rest.

---

### 4.2 Frontend (React / TypeScript)

**Positives:**
- TypeScript strict mode is enabled (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
- All types in `src/types/` are well-separated by domain
- Dual API client design with per-client interceptors is clean and maintainable
- Route-level code splitting with `React.lazy` + `Suspense` is correctly implemented
- Zod validation is used for form schemas
- Tailwind design tokens (brand colours, surface colours, typography) are properly centralised in `tailwind.config.js`

**Observations:**

**OBS-005 — `App.tsx` Returns `null`**
`src/App.tsx` is an empty shell that returns `null`. The actual router is bootstrapped in `main.tsx` via `RouterProvider`. This file serves no purpose and creates confusion for developers onboarding.

**Recommendation:** Either remove `App.tsx` entirely or make it the root provider wrapper, removing the redundancy.

---

**OBS-006 — `dist/` Directory May Be Committed**
The `dist/` folder (Vite build output) is listed in the directory structure. Production build artefacts should not be committed.

**Recommendation:** Confirm `dist/` is in `.gitignore`. Build artefacts belong in CI/CD pipelines, not version control.

---

**OBS-007 — No Error Boundary in Frontend**
There is no `<ErrorBoundary>` component wrapping route or page components. An unhandled rendering exception in any page component will blank the entire application.

**Recommendation:** Wrap the route outlet in `AppShell` with a React ErrorBoundary that displays a fallback UI and logs the error.

---

**OBS-008 — Token in URL Param Risk (TBC)**
If any redirect after login passes the token as a URL query parameter at any point (e.g., for deep linking), it will be logged in server access logs and browser history. Confirm this is not the case.

---

## 5. Test Coverage Assessment

### 5.1 Current Test Inventory

| Layer | Framework | Test Files | Status |
|-------|-----------|------------|--------|
| Phase 1 Validator | pytest | `test_phase1_validator.py` | Good — comprehensive unit tests |
| Config | pytest | `test_config.py` | Present |
| Logging Middleware | pytest | `test_logging_middleware.py` | Present |
| Redis Client | pytest | `test_redis_client.py` | Present |
| Phase 2–5 Pipeline | pytest | **Missing** | Gap |
| L4 Agent (LLM Stages) | pytest | **Missing** | Gap |
| Admin API Routes | pytest | **Missing** | Gap |
| KB Compiler / Vectorisation | pytest | **Missing** | Gap |
| Frontend Unit/Component | Vitest | **Missing** | Gap |
| E2E RBAC Flow | Playwright | `access.e2e.spec.ts` | Present — good coverage |

### 5.2 Test Quality: What Exists is Good

The `test_phase1_validator.py` file is the highest-quality test in the suite and serves as the template for what the rest should look like:
- Clean class-based test grouping by concern
- `_make_request()` factory helper avoids duplication
- All external dependencies (DB, Redis) are patched at the call site
- Both positive and negative paths are covered (empty input, too-long, SQL injection, customer block, sandbox mode, image flag warnings)
- Tests are fast (no I/O)

The `conftest.py` is correctly designed: `isolate_env` (autouse) prevents test pollution from `.env` file; `mock_redis` and `mock_db_session` are proper fixtures.

The Playwright E2E spec is well-structured: it creates test users via the API in `beforeAll`, tests each role's visible/hidden navigation items, and asserts that blocked paths redirect to dashboard. Page error detection (`pageerror` listener) is a thoughtful addition.

### 5.3 Coverage Gaps (Critical)

**GAP-003 — No Tests for Phases 2–5**
The deduplicator, handler, enricher, and dispatcher are completely untested. Phase 3 source verification (HMAC, Bearer token) and Phase 5 Redis stream dispatch are business-critical paths.

**GAP-004 — No Integration Tests for Ingest Endpoint**
The `POST /cardinal/ingest` endpoint — the primary entry point for all ticket data — has no integration test using `TestClient` / `httpx.AsyncClient`.

**GAP-005 — No Tests for LLM Pipeline Stages**
All four LLM stages (classifier, evaluator, validator, responder) in `app/l4_agents/ecommerce/` have no test coverage. LLM prompt regression testing is important as model versions change.

**GAP-006 — No Frontend Unit or Component Tests**
There are no Vitest tests for React components, hooks, or stores. Critical components (LoginPage, AuthGuard, AccessGuard, API interceptors) have no test coverage.

**GAP-007 — No Performance / Load Tests**
No evidence of load testing against the ingest endpoint or Redis stream consumer. SLA breach handling (P1 queue) cannot be verified without baseline performance metrics.

### 5.4 Test Coverage Target Recommendations

| Layer | Current Estimate | Recommended Target |
|-------|-----------------|-------------------|
| Backend unit tests | ~30% | 80% |
| Backend integration tests | ~5% | 70% |
| Frontend unit/component | 0% | 60% |
| E2E | ~40% (RBAC only) | 80% (core user flows) |

---

## 6. Observability & Monitoring Assessment

### 6.1 What Is Present

- **Structured JSON Logging:** `python-json-logger` is configured; `LOG_FORMAT` can be toggled (JSON for prod, text for dev). `CorrelationIdMiddleware` injects correlation IDs for request tracing.
- **Prometheus Metrics:** `prometheus-client` is present; metrics endpoint is registered in the governance plane middleware. `app/metrics.py` defines histograms, counters, and gauges including database pool stats.
- **OpenTelemetry:** SDK + API installed. Configurable OTLP exporter for distributed tracing to Jaeger/Tempo. FastAPI, SQLAlchemy, and Redis instrumentation packages are included in `requirements.txt`.
- **Worker Heartbeat:** `GET /health/worker` exposes `last_heartbeat_s`, `jobs_processed`, and `poll_interval` — useful for detecting stalled vector workers.
- **System Status Endpoint:** `GET /system-status` checks database, Redis, Weaviate connectivity and returns the active policy version. Suitable as a readiness probe.

### 6.2 Gaps

**GAP-008 — No Alerting Rules Defined**
Prometheus metrics are exported but there are no alert rules (no `alerts.yaml`, no Grafana dashboard definition, no PagerDuty/OpsGenie integration).

**GAP-009 — LLM API Latency / Error Metrics Not Confirmed**
The four-stage LLM pipeline makes external API calls to OpenAI. If LLM latency spikes or the API rate-limits, there is no specific metric tracking this in the reviewed code.

**Recommendation:** Add a `llm_stage_duration_seconds` histogram per stage and a `llm_api_error_total` counter. These are the most important operational metrics for a system of this type.

**GAP-010 — No Dead-Letter Queue Monitoring**
Messages that exceed Celery max retries go to a dead-letter state. There is no confirmed monitoring or alerting on the DLQ size.

---

## 7. Deployment & Infrastructure Assessment

### 7.1 Docker Compose Review

The `docker-compose.yml` is functionally correct for local development:
- All 8 services defined with correct port mappings
- Named volumes (`pgdata`, `weaviate_data`) for data persistence
- Service dependencies are defined

**Concerns:**

**GAP-011 — No Health Check Definitions in Compose**
No `healthcheck:` directives are defined for any service. This means Docker considers a service "healthy" as soon as the process starts, before the actual application is ready.

**Recommendation:**
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
  interval: 10s
  timeout: 5s
  retries: 5
```
Apply to all HTTP services. Use `redis-cli ping` for Redis, `pg_isready` for Postgres.

---

**GAP-012 — No Resource Limits**
No `mem_limit`, `cpus`, or `ulimits` are set. In development this is acceptable; in any shared or production environment, a runaway worker can consume all host memory.

---

**GAP-013 — Missing Production Compose Override**
There is only one `docker-compose.yml`. A `docker-compose.prod.yml` override is needed for:
- Removing debug volumes and bind mounts
- Setting restart policies (`restart: unless-stopped`)
- Enabling TLS/SSL
- Injecting secrets from a vault rather than environment variables

---

**GAP-014 — No Migration Strategy**
There is no Alembic (or equivalent) migration framework. The database schema is bootstrapped from a SQL export file. This makes schema evolution brittle — any schema change requires a new export.

**Recommendation:** Introduce Alembic immediately. This is a blocking concern for a long-lived production system.

---

### 7.2 Dockerfile Review

Backend Dockerfile uses `python:3.12-slim` — appropriate. However:

**OBS-009 — No Non-Root User in Dockerfile**
The container runs as root. This is a container security baseline violation.

**Recommendation:**
```dockerfile
RUN addgroup --system app && adduser --system --ingroup app app
USER app
```

**OBS-010 — Dependencies Reinstall on Every Code Change**
The Dockerfile does not layer `COPY requirements.txt` before `COPY . .`. This means every code change invalidates the dependency cache.

```dockerfile
# Correct pattern (cache-friendly):
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
```

---

## 8. Frontend Quality Assessment

### 8.1 Dependencies

**Positive:** Dependency versions are modern and well-chosen:
- React 19.2.0 (latest stable)
- Vite 7.3.1 (latest)
- TypeScript ~5.9.3
- React Router 7.13.1 (latest)
- TanStack Query 5.90.21

**Concern:**

**OBS-011 — 45 Production Dependencies**
The `package.json` lists 45 runtime dependencies. While many are justified (Radix UI components, recharts, date-fns), the total bundle size and attack surface should be audited. Run `npm audit` and `npm ls --depth=0` to identify outdated or vulnerable packages.

**OBS-012 — `node_modules/` May Be Committed**
The directory listing shows `node_modules/` in the project directory. This must not be version-controlled.

**Recommendation:** Confirm `node_modules` is in `.gitignore` and remove from any existing commits if present.

---

### 8.2 Code Quality

**Positive:**
- ESLint configured with `typescript-eslint recommended` + React hooks rules
- Strict TypeScript settings enforced
- Tailwind design tokens are well-structured (brand green palette, surface/card colours, monospace fonts)

**Concern:**

**OBS-013 — No Vitest or Jest Configuration**
Despite having a `package.json` with scripts (`dev`, `build`, `lint`, `preview`), there is no `test` script and no unit test framework configured. Playwright is present for E2E only.

**Recommendation:** Add Vitest (natural fit with Vite) and write component tests for at minimum: LoginPage, AuthGuard, AccessGuard, API interceptors, and Zustand store actions.

---

## 9. Open Issues Summary

### Critical (Must Fix Before Production)

| ID | Issue | Component | Impact |
|----|-------|-----------|--------|
| SEC-001 | Credentials in `.env` file (API keys, DB password) | Backend | Full system compromise |
| SEC-002 | CORS wildcard with credentials | Both services | Cross-origin admin API access |
| SEC-003 | Hardcoded static admin tokens | Compose / Tests | Trivial auth bypass |

### High

| ID | Issue | Component | Impact |
|----|-------|-----------|--------|
| SEC-004 | Token in localStorage (XSS risk) | Frontend | Token theft |
| SEC-005 | No TLS on database connection | Backend | Data in transit exposed |
| GAP-014 | No database migration framework | Backend | Schema evolution blocked |
| BUG-001 | Background worker unsafe for scale-out | Governance | Race conditions on vector jobs |

### Medium

| ID | Issue | Component | Impact |
|----|-------|-----------|--------|
| BUG-002 | In-memory rate limiting | Backend | Rate limiting bypassed on multi-instance |
| SEC-006 | Frontend-only RBAC (backend validation unconfirmed) | Both | Unauthorised API access possible |
| GAP-003 | No unit tests for Phases 2–5 | Backend | Regressions undetected |
| GAP-004 | No integration tests for ingest endpoint | Backend | Critical path untested |
| GAP-006 | No frontend unit/component tests | Frontend | UI regressions undetected |
| GAP-008 | No alerting rules | Infra | Silent failures in production |
| GAP-011 | No health checks in Docker Compose | Infra | Premature service routing |
| OBS-007 | No React ErrorBoundary | Frontend | Blank screen on render error |
| OBS-009 | Container runs as root | Docker | Container escape risk |

### Low / Observations

| ID | Issue | Component | Impact |
|----|-------|-----------|--------|
| OBS-001 | Deprecated `get_connection()` still present | Backend | Accidental pool bypass |
| OBS-002 | `second_path4.md` in backend root | Backend | Repo hygiene |
| OBS-003 | `test_weaviate.py` in backend root | Backend | Not discovered by pytest |
| OBS-004 | SQL export committed to repo | Backend | Data governance risk |
| OBS-005 | `App.tsx` returns null | Frontend | Developer confusion |
| OBS-006 | `dist/` may be committed | Frontend | Repo bloat |
| OBS-010 | Inefficient Dockerfile layer order | Docker | Slow build cache |
| OBS-012 | `node_modules/` may be committed | Frontend | Massive repo bloat |
| GAP-007 | No load/performance tests | Testing | SLA limits unknown |
| GAP-009 | LLM latency not metriced | Observability | Blind spot in prod |
| GAP-010 | DLQ not monitored | Observability | Silent message loss |
| GAP-012 | No container resource limits | Docker | Resource contention |
| GAP-013 | No prod docker-compose override | Docker | Config parity issues |

---

## 10. Recommendations — Prioritised Action Plan

### Sprint 1 (Immediate — Block on Production Gate)

1. **Rotate all exposed credentials** (OpenAI, Postgres, Freshdesk) — treat as compromised.
2. **Implement secrets management** — inject via environment at runtime, never in committed files.
3. **Fix CORS** — restrict `allow_origins` to known domains per environment.
4. **Replace hardcoded tokens** — use cryptographically random values; read test tokens from env vars.
5. **Add `.env`, `dist/`, `node_modules/` to `.gitignore`** and remove from git history if tracked.

### Sprint 2 (Quality Gate)

6. **Add Alembic** for database migrations.
7. **Write integration tests** for `POST /cardinal/ingest` using `httpx.AsyncClient`.
8. **Write unit tests** for Phases 2–5 of the pipeline.
9. **Add Vitest** and write component tests for critical frontend components.
10. **Add React ErrorBoundary** to AppShell.

### Sprint 3 (Production Hardening)

11. **Migrate rate limiting to Redis** for distributed enforcement.
12. **Migrate vector background worker to Celery Beat** for multi-instance governance.
13. **Add Docker health checks** to all services.
14. **Run as non-root** in all Dockerfiles.
15. **Enable `sslmode=require`** on PostgreSQL connections.
16. **Add `httpOnly` cookie auth** to replace localStorage token storage.

### Sprint 4 (Observability & Scale)

17. **Define Prometheus alert rules** (error rate, queue depth, LLM latency, DLQ size).
18. **Create Grafana dashboards** for the four key operational areas (ingest throughput, LLM pipeline, vector jobs, system health).
19. **Add `llm_stage_duration_seconds` histogram** per LLM stage.
20. **Create `docker-compose.prod.yml`** override with resource limits and secure config.

---

## 11. Conclusion

Kirana Kart demonstrates solid engineering intent. The pipeline architecture is well-thought-out, the priority dispatch design is production-appropriate, and the developer experience tooling (Vite, TypeScript strict mode, Playwright) reflects good engineering discipline. The codebase is maintainable and reasonably well-organised.

The blockers are not architectural — they are security hygiene issues and test coverage gaps that are fixable within two focused sprints. The three critical security findings (exposed credentials, CORS wildcard, hardcoded tokens) must be addressed before the system handles any real customer data. The test coverage expansion is equally important to prevent silent regressions in a pipeline where LLM calls and Redis stream processing are deeply interdependent.

With the Sprint 1 and Sprint 2 items resolved, this platform would be suitable for a controlled production pilot. Full production readiness (hardening + observability) is achievable within the Sprint 3–4 timeline.

---

*Report prepared by QA
For internal use only — do not distribute externally*
