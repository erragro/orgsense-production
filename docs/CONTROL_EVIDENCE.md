# Engineering control evidence

Reviewed 2026-09-13 against the supplied OrgSense Hardening Register. These are
implementation claims with a defined scope, not certification of compliance.
Production evidence must be collected after deployment; a local test is not a
record of a live control operating.

| Control / scope | Implementation | Executable evidence | Runtime evidence |
| --- | --- | --- | --- |
| Administrative reset revocation | database credential version and atomic refresh invalidation | PostgreSQL reset/racing-issuance regression | rejected old credentials across replicas |
| Governance endpoint authentication | `auth_service.get_current_user`; mounted dependency graph | `test_control_contracts.py` | Auth rejection responses; request correlation IDs |
| Ingest source authentication before writes | `routes.require_verified_source`; constant-time Freshdesk HMAC | `test_ingest_source_verification.py` | HTTP 401 on unsigned/modified payloads |
| Customer identity storage | `customer_pii.py`; all identified customer writers; migrations 0002 and backfill tool | `test_customer_pii.py`; database backfill/search/rollback and block-check tests | Backfill count and verification result; ciphertext and blind indexes in customer table |
| Customer list/detail access audit | `customers.py` → `log_pii_access` | per-handler AST contract; database audit insert test | `kirana_kart.pii_access_log` (field names, actor, entity and IP; no identity values) |
| Retention execution | `beat_retention_sweep` → `run_retention_sweep`; singleton Beat deployment | schedule/caller contracts; real SQL expired-row test | retention sweep logs with affected counts; verify Beat/worker task delivery |
| Policy activation visible to Cardinal | `KBRegistryService._activate_version`; phase 4 policy resolution | real SQL activation and failed-activation rollback test; five-phase pipeline test | both runtime pointer and active policy flag; publish metric/log |
| Dependency readiness | `/ready`, independent bounded PostgreSQL and Redis checks | outage tests; deployment probe definitions | HTTP 503; Kubernetes Ready condition |
| Worker wrapper health | `worker_health.py` | dead-child and unavailable-dependency tests | `/health`, `/ready`, child exit code |
| Reproducible schema | Alembic revisions 0001–0007, version check on API startup | empty upgrade/downgrade/upgrade and restricted-role tests | `public.alembic_version`; deployment job completion |
| No new runtime DDL | frozen legacy DDL registry; removed request-time creates | AST ratchet in `test_control_contracts.py` | schema-owner credentials confined to migration job |
| Error and backlog monitoring | `operational_metrics.py` decorators and background refresh | enrichment failure metric test; deadline integration test | `orgsense_operations_total`, queue/deadline/collector-health gauges; Prometheus rules |
| Grievance ownership and deadline | due date migration; admin assignment/resolution endpoints | real SQL deadline, assignment and resolution test | `grievances.due_at`, `owner_user_id`, `resolved_at`; overdue/unassigned metrics |
| Risk profile refresh | order/complaint change triggers; acknowledged snapshot IDs | real SQL counts and failed-refresh retry test | change log processed flags; profile computation timestamps |
| Scheduled cleanup and conversation QA | dedup timestamp and completed-conversation schema contracts | real SQL expiry preservation and QA persistence tests | deleted counts; stored conversation scores |
| Build regression gate | GitHub Verification workflow; strict TS build; coverage ratchet | pytest, TypeScript, production build, Playwright smoke suite | GitHub check and test artifacts |

## Claims not established

- A live backup restore, measured RTO/RPO, key rotation, or incident response drill.
- Legal deadline correctness, lawful processing, consent sufficiency, data residency,
  processor retention/DPA status, or a complete erasure/export implementation.
- Encryption of PII outside the three customer columns, including historical
  `fdraw.canonical_payload`, raw ticket emails, CRM records, transcripts and exports.
- Audit coverage across every PII response, or a durable fail-closed audit sink.
- Delivery of alerts to a real on-call destination. Rules are supplied; the
  receiver and an end-to-end paging test require operational configuration.
- Browser coverage of every authenticated workflow. Smoke tests cover public
  rendering, anonymous route protection, a mocked cookie login/reload flow, SSE
  parsing and nginx security headers; they do not exercise every live workflow.
- Live-schema equivalence: the migration baseline was reconstructed from the
  repository's historical schema and application definitions, not the live server.

The freeze registry detects new runtime DDL but intentionally permits removing
legacy definitions. Control call-site tests are a guard against unwired code;
behavioral database tests remain necessary to prove the SQL actually works.
