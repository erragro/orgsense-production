# Local hardening validation — 2026-09-13

This records the first pass. See [the second audit remediation](AUDIT_REMEDIATION.md)
for the current changes and verification counts.

The repository and supplied OrgSense Hardening Register were reviewed. Changes are
local and have not been deployed. This record describes observed checks, not a
production-readiness certificate.

| Check | Observed result |
| --- | --- |
| Backend unit/control suite | 171 passed; integration tests excluded |
| Coverage ratchet | 34.17% line coverage; checked-in floor matches measured result |
| PostgreSQL integration suite | 11 passed on disposable pgvector/PostgreSQL 16 |
| Schema rehearsal | Empty database upgrade → downgrade → upgrade, revisions 0001–0005 |
| TypeScript and frontend production build | Passed |
| Chromium smoke suite | 2 passed: public page rendering and anonymous dashboard/login protection |
| Docker Compose configuration | Passed `docker compose config --quiet` |
| Nginx configuration | Passed `nginx -t` using nginx:1.27-alpine |
| Prometheus alert rules | Official promtool validation passed; 8 rules |
| Whitespace/error check | Passed `git diff --check` |

Integration coverage includes customer PII backfill, exact email lookup,
byte-identical synthetic rollback, PII audit persistence, retention, policy
activation/rollback, a five-phase Cardinal execution, restricted runtime schema
access, grievance metrics, failed risk-refresh retry, dedup expiry, and persisted
conversation QA. External LLM and Redis behavior is not established by those SQL
tests. Readiness failure behavior and worker multiprocess metrics have separate
unit tests.

Local Python is 3.13.4; the committed CI workflow uses 3.12. Local frontend builds
used Node 23; CI uses Node 22. Hosted CI has not been executed by this local change.
The frontend build reports a large bundle warning; no performance/load benchmark
was conducted. Overall backend coverage remains modest: the ratchet preserves the
observed baseline and does not establish comprehensive feature coverage.

Before release, complete the [deployment runbook](PRODUCTION_RUNBOOK.md), especially
live schema adoption, a restored-snapshot rehearsal, PII key/backfill verification,
secret rotation, required branch checks, and real alert receiver delivery. Review
[control evidence and limits](CONTROL_EVIDENCE.md) for the scope of privacy and
security claims. Historical export removal from shared Git history remains a
coordinated operation. No shared history was rewritten or production credentials
rotated during this work.
