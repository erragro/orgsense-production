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
| Rules govern live decisions | `rule_engine.py` (fail-closed evaluator, runtime precedence) in Stage 2 before fraud/tier/routing; `RULE_ENFORCEMENT` observe/enforce | `test_rule_engine.py`; `test_rule_enforcement.py` (PostgreSQL: worker rule query, Stage 2, persistence, summary) | `llm_output_3.rule_decision`; `GET /bpm/rule-decisions/summary`; `rule.*` Stage 2 span attributes |
| Policy Studio change control | `policy_lifecycle.py` (server-driven stages, edit lock, separate approver, single-transaction activation); `rule_routes` write guard | `test_policy_studio_lifecycle.py` (PostgreSQL, over HTTP: upload → review → replay → approval → live, rollback on failed activation, rejection); `test_policy_lifecycle.py`, `test_bpm_publish.py`, `test_simulation_gate.py` | `bpm_stage_transitions` (actor, notes, justification, previous version), `bpm_approvals` (requester, reviewer), `bpm_gate_results` |
| Closed issue taxonomy | `sop_extractor` map-only extraction and gaps; `taxonomy_problems` at submit; Stage 0 `policy_knowledge.resolve_issue`; Stage 2 `issue_not_in_taxonomy` to human review | `test_policy_knowledge.py`; `test_policy_studio_lifecycle.py` (PostgreSQL: gaps, taxonomy unchanged by publish, Stage 0 on the live policy) | `policy_taxonomy_gaps`; `llm_output_1` issue codes; `stage.taxonomy_status` span attribute |
| Reviewed SOP knowledge and retained edits | `policy_knowledge_chunks` in the approval fingerprint; required reasons; `rule_edit_log.field_changes`; `lessons_for` in every extraction prompt | same PostgreSQL test (edits, diffs, variables blocking submission, lessons in the next prompt) | `rule_edit_log` (`proposed` vs reviewer rows, business line, reason; stage `variable` for tenant value changes) |
| Dependency readiness | `/ready`, independent bounded PostgreSQL and Redis checks | outage tests; deployment probe definitions | HTTP 503; Kubernetes Ready condition |
| Worker wrapper health | `worker_health.py` | dead-child and unavailable-dependency tests | `/health`, `/ready`, child exit code |
| Reproducible schema | Alembic revisions 0001–0011, version check on API startup | empty upgrade/downgrade/upgrade and restricted-role tests | `public.alembic_version`; deployment job completion |
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
