# Second audit: remediation and remaining release work

Reviewed against the pasted backend/security/frontend/infra audit on 2026-09-13.
No production deployment or cloud configuration changes were made.

| Finding | Code disposition |
| --- | --- |
| Password reset leaves sessions valid | Fixed. Reset increments `users.auth_version` and deletes refresh tokens atomically. Every authenticated request checks the uncached database version. Refresh rotation and issuance serialize with reset using a user-row lock. A racing login cannot store a refresh credential for the previous version. |
| Customer encryption has no writer | The audit's zero-caller statement is stale: `simulation/run_simulation.py` calls `protect_customer` before its customer upsert. The other identified customer mutations erase/expire PII. Production startup requires the key and completed backfill. This does not establish encryption for unrelated raw/CRM/transcript columns or external writers. |
| Pipeline bypasses pooling | Replaced application `psycopg2.connect` calls with a shared pooled adapter that preserves psycopg2 transaction contexts. Connections inherited across a fork are rejected on checkout. BI retains its separate read-only role/engine; readiness retains its deliberately independent bounded probe. |
| Nginx lacks headers | Added CSP, frame denial, MIME-sniff protection, referrer policy, HSTS and permissions policy, including locations that override header inheritance. Switched UI to unprivileged nginx on port 8080. Container tests cover HTML, health and missing assets under a read-only root filesystem and dropped capabilities. |
| npm advisories | Applied compatible dependency fixes and updated the lockfile. `npm audit fix` reported zero vulnerabilities at this check. Typecheck, build and browser tests pass after the update. |
| Kubernetes hardening/resilience | Added pod/container security contexts, disabled service-account token mounting, writable `/tmp`, topology spreading for replicated services, disruption budgets, API/UI CPU autoscaling, and network policies. These manifests still require cluster validation. |
| Mutable app deployment images | Replaced `latest` with deliberately non-runnable `RELEASE_REQUIRED` source placeholders. `scripts/render_k8s_release.py` requires repository@sha256 digests for every application image. Cloud Build tags application releases by full commit SHA. |
| Group integration keys in plaintext | New/regenerated group keys are stored as SHA-256 hashes, with full values returned only on issuance. Migration 0007 hashes legacy rows. List responses contain only a mask. Generic integration configuration secrets are a separate surface and have not been migrated by this change. |
| Rate limiting behind proxies | Added forwarding-chain resolution gated by explicit `TRUSTED_PROXY_CIDRS`, with spoofing tests. Empty configuration ignores headers. The correct production CIDRs must be supplied by the operator. |
| Cloud Build bypasses tests | Both build definitions now start with `scripts/require_ci.py`. Missing, failed, wrong-commit, or non-GitHub-Actions checks block deployment. Configure `_GITHUB_REPOSITORY`; private repositories also require a securely bound read-only GitHub token. The gate requires all six verification/security checks. |
| Stale browser auth test | Replaced legacy admin-header provisioning with a browser cookie-flow contract covering login, reload and absence of tokens in localStorage. It uses mocked HTTP responses; real token revocation has PostgreSQL tests. |
| Group API contract casts | Removed casts around group client calls, replaced the nonexistent save method with typed create/update, supplied key-generation input and adapted the returned integration list. Newly issued keys are held only in component memory. Removed an advertised endpoint/example that had no backend implementation. |
| Duplicated AI stream parsing | Both screens use `readSSEData`, with fragmented Unicode, CRLF/multiline-event and cancellation tests. Premature stream termination becomes an error. The large presentation components remain candidates for a separate maintainability refactor. |
| Weaviate drift/data loss | Aligned Kubernetes with Compose's 1.29.4 version and replaced ephemeral vector storage with a 20Gi PVC and Recreate deployment strategy. Existing vectors must be backed up/migrated before switching storage. |

## Verified locally

- 176 backend unit/control tests and 14 PostgreSQL integration tests passed.
- Seven-revision empty-database upgrade/downgrade/upgrade passed.
- Strict TypeScript production build passed; the large-bundle warning remains.
- Six Playwright tests passed against the hardened nginx container, including
  cookie-flow, SSE parser and security-header checks.
- Compose configuration and the coverage ratchet passed. The baseline is recorded
  in `kirana_kart/coverage-floor.json`; coverage is still modest.

## Release configuration that must be completed

Follow [the production runbook](PRODUCTION_RUNBOOK.md) for live-schema adoption,
backup/restore, PII cutover, key rotation, alert receiver testing and branch checks.
Additionally:

1. Set `_GITHUB_REPOSITORY=owner/repository` on both Cloud Build triggers. For private
   repositories bind `GITHUB_TOKEN` to the gate step using Cloud Build Secret
   Manager `availableSecrets`/`secretEnv`; the token needs read access to checks.
   A run started before CI completes intentionally fails; retry after the required
   checks pass. Empty/short commit identifiers are rejected. This has not been
   exercised against the actual hosted repository or deployed trigger.
2. Render, review and store immutable manifests with the release evidence:

   ```sh
   .venv/bin/python scripts/render_k8s_release.py \
     --governance "$GOVERNANCE_IMAGE_DIGEST" \
     --ingest "$INGEST_IMAGE_DIGEST" \
     --ui "$UI_IMAGE_DIGEST" > release.yaml
   ```

   Values must be full `repository@sha256:<64 hex>` references. Do not directly
   apply the source templates. Verify images, secrets, storage class, quota and
   network reachability using cluster-side validation before rollout.
3. Set `TRUSTED_PROXY_CIDRS` from the actual proxy peer networks, and align Uvicorn's
   `FORWARDED_ALLOW_IPS` with that same trust boundary. Never trust `*` or all
   client networks. Test two distinct external clients through the actual load
   balancer to verify rate-limit separation and spoof rejection.
4. Confirm the network-policy controller enforces policies. The supplied policy
   permits same-namespace traffic, known external service ports, public API/UI
   ports and monitoring scrapes. Narrow external database/Redis destination CIDRs
   and add actual external collector routes as required. This is not a claim of
   destination-level egress isolation.
5. A singleton's `minAvailable: 1` blocks voluntary drain; it does not make that
   process highly available or protect against node failure; see the
   [Kubernetes disruption documentation](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/). Coordinate Beat,
   poller and Weaviate maintenance. Do not run multiple Beat schedulers. HPA needs
   Metrics Server and capacity. Size DB connection limits for all API and Celery
   processes/replicas; pooling is per process, not a cluster-wide quota.
6. Provision and validate the Weaviate PVC and restore existing data before
   cutover. Read-only application roots deliberately prevent in-place model-file
   writes; any enabled local model-training workflow needs a separately designed
   durable artifact store/job before release. Only the UI image's constrained
   runtime was executed locally in this pass.
7. Migration 0007 cannot reconstruct plaintext keys on downgrade. Coordinate any
   out-of-repository group-key consumers to compare hashes, or rotate credentials.
   No direct group-ticket ingestion endpoint is currently implemented; the UI no
   longer advertises one. Other integration-config secrets still require a
   separate encryption/secret-manager migration.

These changes address the supplied findings at their stated code boundaries.
They do not establish full privacy-law compliance or prove every authenticated
feature works in the deployed environment.
