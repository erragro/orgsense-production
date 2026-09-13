# Auralis — CX Operations Platform

**Version:** 6.0.0
**Live at:** [orgsense.in](https://orgsense.in)
**Stack:** FastAPI · React 19 · PostgreSQL · Weaviate · Redis · Celery · OpenAI · Docker · GKE

---

## What Is This?

Auralis is a **full-stack AI-powered customer experience operations platform** built for teams that manage high-volume support at scale.

It covers the complete ticket lifecycle — from raw inbound complaint through automated decision, routing, quality scoring, and resolution — replacing tribal knowledge and manual judgment with deterministic pipelines and LLM-assisted intelligence.

Built by practitioners who ran CX operations at Swiggy before building the platform they wished existed.

---

## Platform Modules

| Module | Description |
|---|---|
| **Cardinal Pipeline** | 5-phase ingestion → decision engine. Validates, deduplicates, enriches, classifies, and routes every ticket with zero manual input. |
| **L2 Validator** | Smart deduplication and rule-based conflict detection. Catches routing conflicts before they reach agents. |
| **BI Agent** | Ask your operations data in plain English. Generates SQL, returns charts and insights — no data team required. |
| **QA Agent** | 10-parameter automated quality scoring across every agent interaction. Audit at scale, not by sampling. |
| **CRM & Ticket Ops** | Full ticket lifecycle — SLA tracking, automation rules, CSAT, escalation paths, merge flows, team dashboards. |
| **Knowledge Base** | Versioned SOP management with RAG-powered search. Policy-as-code with simulation before rollout. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     React UI  (orgsense.in)                         │
│   JWT auth · per-module RBAC · OAuth (GitHub / Google / Microsoft)  │
└──────────────────────┬──────────────────────────────────────────────┘
                       │  REST / Axios + Authorization: Bearer <token>
         ┌─────────────┴──────────────────────┐
         ▼                                    ▼
┌──────────────────┐                ┌──────────────────────┐
│  Governance API  │                │     Ingest API       │
│     :8001        │                │       :8000          │
│                  │                │                      │
│ /auth/*          │                │ POST /ingest         │
│ /users/*         │                │ (5-phase pipeline)   │
│ /crm/*           │                └──────────┬───────────┘
│ /kb/*            │                           │ Redis Streams
│ /bi-agent/*      │                           ▼
│ /qa-agent/*      │                ┌──────────────────────┐
│ /cardinal/*      │                │    worker-poll       │
│ /analytics/*     │                │    worker-celery     │
└──────────────────┘                └──────────┬───────────┘
                                               ▼
                              ┌──────────────────────────────┐
                              │  PostgreSQL · Weaviate · Redis│
                              └──────────────────────────────┘
```

---

## Access Control

Auralis uses per-module RBAC with explicit admin grant required for sensitive modules.

| Module | New User Default | Notes |
|---|---|---|
| Dashboard, Tickets, Sandbox | `view` | Granted on signup |
| Taxonomy, Knowledge Base, Policy | `view` | Granted on signup |
| Customers, Analytics | `view` | Granted on signup |
| **Cardinal** | ❌ none | Admin must grant |
| **BI Agent** | ❌ none | Admin must grant |
| **QA Agent** | ❌ none | Admin must grant |
| **CRM** | ❌ none | Admin must grant |
| System, Users | ❌ none | `is_super_admin` only |

Super admin bootstrap is opt-in through `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. Open registration is disabled by default; enabled registration creates inactive accounts with no permissions.

---

## Rate Limiting

Two-layer protection against brute force and DDoS:

**nginx Ingress (network layer):**
- 20 req/s per IP with burst of 60 — returns HTTP 429 beyond limit
- Max 10 concurrent connections per IP

**slowapi (application layer, per-endpoint per-IP via Redis):**

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 10/minute |
| `POST /auth/signup` | 5/minute |
| `POST /bi-agent/query` | 30/minute |
| `POST /qa-agent/evaluate` | 20/minute |

---

## Public Pages

The platform has a public marketing surface before the auth wall:

| Route | Page |
|---|---|
| `/` | Landing page — platform overview, capabilities, problem/solution |
| `/team` | Team portfolio — founder profiles and background |
| `/login` | Sign in (email/password + GitHub/Google/Microsoft OAuth) |
| `/signup` | Create account (DPDP Act §6 consent required) |

Authenticated users visiting `/` are automatically redirected to `/dashboard`.

---

## Production hardening status

The repository now includes an executable verification workflow, versioned schema,
customer identity encryption/backfill tools, dependency readiness and operational
alerts. Read [the deployment runbook](docs/PRODUCTION_RUNBOOK.md) before deploying:
existing databases require an explicit schema comparison/adoption and a rehearsed
PII cutover. Production startup rejects an unmigrated database or plaintext
customer identities. This source change has not been deployed or certified.

Tested scope and unresolved operational/legal claims are in
[the evidence register](docs/CONTROL_EVIDENCE.md).

## Local Development

### Prerequisites
- Docker Desktop
- Node.js 20+
- Python 3.12

### Start everything

```bash
cp .env.example .env
cp .env.example kirana_kart/.env
# Configure DB/Redis/JWT/PII keys and optional integrations before starting.
docker compose up -d
```

Services:
- UI: http://localhost:5173
- Governance API: http://localhost:8001
- Ingest API: http://localhost:8000
- Weaviate: http://localhost:8080

### Frontend only

```bash
cd kirana_kart_ui
npm install
npm run dev
```

### Backend only

```bash
cd kirana_kart
pip install -r requirements-dev.txt
# Set MIGRATION_DATABASE_URL and runtime environment, then migrate first.
alembic upgrade head
uvicorn app.admin.main:app --reload --port 8001
```

---

## Production Deployment (GKE)

Live at **orgsense.in** — GKE Autopilot cluster, `auralis` namespace.

### Build and push images

```bash
# UI
cd kirana_kart_ui
npm run build
cd ..
docker buildx build --platform linux/amd64 -t asia-south1-docker.pkg.dev/PROJECT_ID/auralis/ui:latest kirana_kart_ui/
docker save asia-south1-docker.pkg.dev/PROJECT_ID/auralis/ui:latest | crane push - asia-south1-docker.pkg.dev/PROJECT_ID/auralis/ui:latest

# Governance API
docker buildx build --platform linux/amd64 -t asia-south1-docker.pkg.dev/PROJECT_ID/auralis/governance:latest kirana_kart/
docker save asia-south1-docker.pkg.dev/PROJECT_ID/auralis/governance:latest | crane push - asia-south1-docker.pkg.dev/PROJECT_ID/auralis/governance:latest
```

### Deploy

```bash
kubectl rollout restart deployment/ui deployment/governance -n auralis
kubectl apply -f k8s/ingress.yaml
```

### Verify

```bash
curl -s -o /dev/null -w "%{http_code}" https://orgsense.in/login
# → 200

# Rate limit test — 11th+ request within a minute returns 429
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code}\n" -X POST https://orgsense.in/api/governance/auth/login -H 'Content-Type: application/json' -d '{"email":"x","password":"x"}'; done
```

---

## Environment Variables

| Variable | Service | Description |
|---|---|---|
| `VITE_GOVERNANCE_API_URL` | UI | Governance API base URL (prod: `/api/governance`) |
| `OPENAI_API_KEY` | governance | OpenAI key for BI/QA agents |
| `DATABASE_URL` | governance | PostgreSQL connection string |
| `REDIS_URL` | governance | Redis connection string |
| `WEAVIATE_URL` | governance | Weaviate endpoint |
| `JWT_SECRET` | governance | JWT signing secret (change in production) |
| `GITHUB_CLIENT_ID/SECRET` | governance | GitHub OAuth app credentials |
| `GOOGLE_CLIENT_ID/SECRET` | governance | Google OAuth credentials |
| `MICROSOFT_CLIENT_ID/SECRET` | governance | Microsoft OAuth credentials |

---

## Team

**Surajit Chaudhuri** — Chief Creator
AI Solutions Architect · AI Product Manager · Full Stack
7+ years at Swiggy engineering operational decision systems. Architect of Iris (replaced Observe.AI, ~₹5Cr cost reduction) and Resolute (8K+ users, 50% AHT reduction, ₹2.4Cr operational savings).

**Renzil Rodrigues** — AI Full Stack Developer
Technical Architect · Process Automation · AI & Content Strategist
Process automation architect at Swiggy. Built AI/NLP escalation-prevention models saving ₹7Cr annually in refund leakage, eliminated 20K+ manual hours, engineered deduplication systems processing 1.5L+ tickets (98% original noise eliminated).

---

## License

Proprietary. All rights reserved. © 2026 Auralis.

See [second audit remediation and current validation](docs/AUDIT_REMEDIATION.md) for session revocation, deployment hardening, and remaining release configuration.
