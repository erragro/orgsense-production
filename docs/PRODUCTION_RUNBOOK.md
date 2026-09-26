# Production hardening deployment

Also complete the [second audit release configuration](AUDIT_REMEDIATION.md),
including immutable manifest rendering, CI attestation, proxy ranges and storage.

This change has not been deployed. Do not roll it out with `rollout restart`
until the database adoption, key/backfill and release gates below are complete.
Use the same immutable image digest for the migration job, APIs and workers.

## Verification from a clean checkout

```sh
python3 -m venv .venv
.venv/bin/pip install -r kirana_kart/requirements-dev.txt
.venv/bin/python -m pytest -q kirana_kart/tests -m 'not integration' --cov=kirana_kart/app --cov-report=json:coverage.json
.venv/bin/python scripts/check_coverage.py coverage.json
npm ci --prefix kirana_kart_ui
npm run build --prefix kirana_kart_ui
cd kirana_kart_ui
npx playwright install chromium
npx playwright test --config=playwright.smoke.config.ts
```

CI runs the database suite against a disposable pgvector PostgreSQL 16 service,
including upgrade → downgrade → upgrade. Local Docker Compose preserves the
existing PostgreSQL **14** major version and uses its pgvector image. An existing
PostgreSQL data volume must never be attached to a different major version without
an explicit PostgreSQL upgrade. The PG14 image tag was verified; the local
integration run used PG16.

Make these checks required in repository branch protection: **Backend tests and
coverage**, **PostgreSQL migrations and controls**, and **Frontend typecheck and
build**, alongside the security scan. A workflow alone cannot prohibit merging.
The coverage checker rejects decreases and requires measured improvements to be
recorded in `kirana_kart/coverage-floor.json`; it does not invent a target percent.

## Schema adoption and deployment

1. Take an encrypted backup and restore it into a separate scratch environment.
   Record the backup timestamp, restore start/end, restored database identity,
   verification result, owner and measured duration. Do not use customer data in CI.
2. Compare the restored schema with a database made by `alembic upgrade head`.
   The baseline is reconstructed from repository sources. In particular, later
   deployments may already contain some tables/columns from revisions 0002–0004.
   Resolve drift explicitly and review a deployment-specific adoption migration;
   **do not blindly stamp head, run baseline creation over a populated schema, or
   edit an already applied revision**. DDL conflicts deliberately stop the job.
3. For a genuinely empty database, provide `MIGRATION_DATABASE_URL` using the
   schema-owner role and run:

   ```sh
   .venv/bin/alembic -c kirana_kart/alembic.ini upgrade head
   ```

   This installs schema and reviewed operational defaults, not customer records,
   compiled policies, or an active production policy. Publish a validated policy
   before enabling ingestion.
4. Give the runtime role schema USAGE, table SELECT/INSERT/UPDATE/DELETE, sequence
   USAGE/SELECT, and SELECT on `public.alembic_version`. Do not grant it CREATE or
   ownership. The migration role owns schema changes. Review function EXECUTE
   grants and BI column/view grants for the actual deployment.
5. For GKE use `k8s/migrate.yaml` with the release image and separately provisioned
   `auralis-migration-env`, wait for job success, then deploy APIs and workers.
   For Cloud Run, provision `orgsense-migrate` once with the owner URL and database
   network access. Cloud Build updates and executes this job before deploying.
6. APIs now require the exact schema revision; production also requires a valid
   32-byte PII key and completed customer backfill. Startup failure is intentional
   if either prerequisite is absent. Liveness is `/health`; readiness is `/ready`.
7. Policy Studio (revision 0008) needs the governance API's vector background
   worker running: an approver cannot activate a submitted policy change until its
   runtime preparation (vectorization) completes. `POLICY_REQUIRE_SEPARATE_APPROVER`
   defaults to `true` (the submitter cannot approve their own change); set it to
   `false` only for a single-owner deployment. Proposals already awaiting approval
   before this revision must be re-submitted (Retry runtime preparation) once.
8. Revision 0009 adds `llm_output_3.rule_decision`. `RULE_ENFORCEMENT` defaults
   to `observe`: rules are evaluated and recorded but do not change outcomes.
   Switch to `enforce` (API and workers) only after reviewing Policy Studio's
   "Rules in live decisions" panel; switching back to `observe` is immediate.
9. Revision 0010 closes the taxonomy. Once a policy is live, Stage 0 only
   classifies into that knowledge base's active `issue_taxonomy` codes;
   anything else is `UNCLASSIFIED` and goes to human review. Before deploying,
   confirm that each live KB's taxonomy covers its ticket types. Watch the
   `issue_not_in_taxonomy` discrepancy rate after the rollout. Taxonomy admins
   work the gap queue (`GET /bpm/kb/{kb}/taxonomy-gaps?status=open`). The UI's
   nginx now allows 600 s on `/api/governance/` for long SOP analyses; an
   external load balancer in front of it needs the same timeout.
10. Revision 0011 lets the first issue be added to an empty taxonomy (the
    snapshot of an empty table was NULL in a NOT NULL column). A failed runtime
    preparation is now recorded as `failed` with its error in
    `kb_vector_jobs.error`, so the approver can retry it; before, the failure
    handler updated a non-existent column and the job was retried every poll
    while the proposal showed `pending`. Check for such stuck jobs when
    deploying: `SELECT * FROM kirana_kart.kb_vector_jobs WHERE status = 'pending'`.
11. Deploy `worker-beat` as **one** replica with Recreate, and workers consuming
   both `cardinal` and `celery` queues. Verify a retention task actually executes.
   Cloud Run worker deployments need continuous CPU/instances appropriate to
   background processing; the repository does not provision those settings.

## Customer identity cutover and rollback

Provision a new 64-hex-character `PII_ENCRYPTION_KEY` in the secret manager and
record its version/owner. Store it independently of backups, with controlled
recovery access. All new customer writes require it. Never print it into a log,
commit it, or pass it on a command line. Populate process environment securely.

Pause all writers for the final cutover. Apply the expanded customer schema first.
From `kirana_kart/`, with owner URL and key provided in environment:

```sh
PYTHONPATH=. ../.venv/bin/python scripts/customer_pii_backfill.py encrypt --batch-size 500
PYTHONPATH=. ../.venv/bin/python scripts/customer_pii_backfill.py verify
```

Each batch commits independently. Re-running encrypt resumes untouched rows;
explicit versioned envelopes avoid heuristic double encryption. The tool validates
round trips before committing. Do not leave an old writer running during/after
cutover. Legacy plaintext reads are temporarily supported, but production startup
rejects remaining plaintext. `verify` also decrypts every value and checks indexes.

Email search is now **exact, trimmed and case-insensitive**, using a keyed HMAC.
Customer-ID substring search remains. Partial-email substring search is no longer
supported; communicate that change before release. Ordinary HMAC cannot preserve
substring matching without exposing additional information. Identity values are
returned decrypted only on existing permission-gated read paths.

Rehearse on the restored snapshot, with writers paused:

```sh
PYTHONPATH=. ../.venv/bin/python scripts/customer_pii_backfill.py decrypt --batch-size 500
```

Compare every identity value to the pre-cutover snapshot, then re-encrypt and
verify before deployment. The local suite proves exact synthetic-value recovery;
it is **not** a production snapshot rehearsal. Schema downgrade refuses to convert
ciphertext DOBs to DATE. Backfill rollback needs the original key. Key rotation
also requires reindexing because the blind-index key is derived from it.

Do not use `downgrade base` on a populated production database: it removes the
application schema. Revisions preserve operator-edited configuration/enrichment
columns where provenance is ambiguous; those downgrades are not a byte-identical
reversal of arbitrary pre-existing schema. Restore from the verified backup if
that is the approved recovery path.

## Monitoring and recovery evidence

Prometheus loads `observability/alerts.yml` for enrichment, LLM, publication,
queue backlog, missed grievance deadlines and collector failures. Provision an
Alertmanager/managed receiver and test delivery to the actual on-call destination.
No receiver or test message is created by this change. Worker wrappers expose
`/metrics` using a fresh per-container Prometheus multiprocess directory, so Celery
child counters are visible. Compose includes worker scrape targets; in Kubernetes,
configure pod discovery for the supplied scrape annotations (or equivalent
PodMonitors). An API scrape cannot see another process's in-memory counters.

Assign requests through the admin `GET /data-rights/grievances` and
`PATCH /data-rights/grievances/{id}` endpoints. The 30-day due date is an operational
target, not a claim about the applicable statutory deadline. Unassigned requests
remain visible and raise a metric; provide a named operational owner.

Record, without secret values:

| Evidence | Required record | Current state |
| --- | --- | --- |
| Secret rotation | secret name/version, rotated-at, owner, verification | Pending live operation |
| Backup restore | backup ID, scratch destination, elapsed duration, result, owner | Pending live rehearsal |
| PII cutover | backup ID, key version, batch/verification counts, rollback comparison | Synthetic test only |
| Alert delivery | rule, injected failure, received-at, destination, owner | Receiver/test pending |
| Release | image digest, migration revision, CI run, smoke result, rollback image | Not deployed |

The database export is ignored and now excluded from backend container builds.
Removal from Git history requires a coordinated rewrite and force-push, followed
by collaborator cleanup. This change does not rewrite shared history or claim
that old secrets/exports have been purged.
