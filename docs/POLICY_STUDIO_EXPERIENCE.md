# Policy Studio: business experience update

The product story is now: **turn written operating knowledge into explainable,
testable business decisions**. Compensation control, consistent resolution and
informed policy changes are the value proposition. No financial returns or
claims of market uniqueness are asserted.

Implemented:

- Policy Studio replaces the Policy BPM navigation label. Customer Problems and
  Policy Testing provide clearer adjacent destinations. An illustrated example
  explains how problems, conditions, responses, sample replay and live comparison
  relate to one another. Model diagnostics are expandable.
- Four business phases organize the existing extraction/review operations:
  Define change → Review decisions → Test impact → Launch decision.
- A name, intended outcome and optional scope are saved in the existing process
  instance metadata when the SOP is uploaded. Scope is descriptive intent, not
  an execution filter; reviewers are told to check the actual rule conditions.
- Reviews use business language, require all pending proposals to be resolved
  before proceeding, and avoid fabricated AI progress percentages.
- Sample replay includes changed-case examples, its actual source and measurement
  limits. A high change rate is a review signal, not a quality verdict. This test
  measures final-action differences, not refund amounts, savings or satisfaction.
- The launch summary uses actual review counts and captured test evidence, carries
  the business brief forward, and exports a Markdown brief for decision makers.
  It no longer claims background testing is complete from a stage label alone.
- The wizard cannot activate from RULE_EDIT, SIMULATION_GATE or SHADOW_GATE. The
  backend rejects those stages before registry promotion or runtime activation,
  preventing an activation followed by an invalid workflow transition. Authorized
  publication at PENDING_APPROVAL and idempotent ACTIVE handling remain supported.
- Live-comparison statistics are filtered to the current/proposed version pair,
  expose the latest observation time and runtime workspace, and explicitly show
  no evidence when no cases exist. The selector uses available version names.
- Dialog keyboard focus, Escape dismissal, sticky header and step scroll reset
  improve usability. Narrow-screen layout is covered in the browser journey.

Verification: strict TypeScript build; 181 backend unit/control tests; seven
Playwright tests against the preview server (the nginx-only header test is
skipped there). The new browser journey uses mocked responses, and its screenshots
contain illustrative cases. No live customer impact is established by these tests.
Coverage ratchet increased from 34.40% to 34.72%.

Limits and next increments:

- Runtime shadow evaluation was not wired into the processing pipeline by this
  change. Configuration is explicitly distinguished from observed execution.
- Version-pair statistics span recorded history; they are not isolated experiment
  runs. Cohort/date selection, experiment IDs, and execution isolation need a
  separate implementation before stronger live-test guarantees.
- Formal approval enforcement across every publication/transition API remains a
  separate governance task. This pass fixes wizard launch eligibility; it does
  not claim a complete approval-control redesign.
- The broader lifecycle still needs its gate orchestration completed to advance
  draft proposals to launch approval. The UI now exposes that blocker instead of
  offering an activation that could partially succeed and then fail.
- Budget projections, outcome-labelled scenarios, SOP passage citations and an
  impact dashboard require additional data and validation. They are not simulated
  with invented numbers here.

Release scope: Policy Studio source changes for `erragro/orgsense-production`. No production deployment is included.

## Review corrections — 14 September 2026

- Activation now requires `policy:admin` in both the wizard and its publish API;
  the API additionally requires admin membership in the selected KB (super-admin
  bypass remains intentional).
- Both wizard priority inputs preserve zero and advertise a minimum of zero.
- Shadow evaluation and statistics select the latest runtime configuration by ID.
  This fixes selection disagreement; it does not add experiment or workspace isolation.
- Unsupported saved condition formats show their original data with an explicit
  warning. The guided editor blocks saving rather than replacing them with an
  empty condition tree. Migration of those rules remains an administrator task.
- Proposal cards display the version identifier alongside the business name.
- Structured gate metrics remain accessible in expandable evidence sections.
- Launch review requests an exact proposal filter on the server, before pagination,
  with the proposal identifier included in the query cache key.
- Remaining comparison labels and the stop-comparison dialog title are corrected.

Validation: 185 backend tests passed (14 database integration tests excluded),
strict TypeScript and production build passed; coverage increased to 34.98%.
Browser regressions cover zero priority, server-filtered proposal review,
publisher versus KB-curator permissions, and legacy-condition overwrite protection.
These tests use mocked API responses. No production deployment is included.

Final browser run: nine passed; the nginx-only header test was skipped on the
Vite preview. The legacy-condition test also exposed and verified a fix for the
rule editor's backdrop intercepting clicks (explicit dialog z-index).

## Production-readiness review — 25 September 2026

The previous passes improved the wording and screens, but the workflow behind
them could not take a proposal live. Verified against a database built by
`alembic upgrade head`:

- **Upload failed on a migrated database.** Instances reference
  `bpm_process_definitions`, which only the retired startup DDL seeded.
- **Every stage change failed.** `BPMService.transition()` writes
  `bpm_process_instances.updated_at`, a column the baseline never had. Approval,
  rejection, compile and the publish endpoint's final step all returned 500.
- **Nothing advanced a proposal.** No UI or server path moved it past DRAFT, so
  the wizard's launch step was permanently blocked. Meanwhile any KB editor could
  call the generic transition endpoint to reach PENDING_APPROVAL → ACTIVE, which
  showed a version as live that the runtime never served.
- **Publishing failed** whenever the SOP introduced anything new:
  `master_action_codes.action_key` was not supplied (NOT NULL), and the taxonomy
  upsert named a unique constraint that does not exist. Wizard proposals also
  never received the compiled `policy_versions` row and vectorization that
  activation requires.
- **Reviewed new responses were silently dropped** during rule generation,
  because they were only registered at publish. L3/L4 rules recorded the parent
  (not the root) as their L1 category. Truncated, colliding rule IDs were possible.
- **Rule editor writes silently rolled back while reporting success.**
  SQLAlchemy does not bind `:param::jsonb`; the swallowed training-sample failure
  aborted the transaction, and COMMIT became a rollback. Manual rule add in the
  wizard sent fields the API does not accept, and the action dropdown endpoint
  selected columns that do not exist. The same cast bug broke KB creation and
  three CRM writes.
- **Governance gaps:** rule routes had no KB membership check and could edit the
  live version directly; instance endpoints accepted an instance from any KB
  through an authorised KB's URL; approvals were not checked against their own
  KB; a submitter could approve their own change; upload size was unbounded.
- **The sample replay used the opposite precedence to the runtime**
  (`priority DESC` vs the worker's `priority ASC`), so the gate measured a
  different policy from the one that would run.

Now implemented (`app/admin/services/policy_lifecycle.py`):

- Stages advance only as their work completes: analysis → rules generated
  (RULE_EDIT) → sample replay (SHADOW_GATE, or SIMULATION_FAILED) → approval
  request (PENDING_APPROVAL) → approval by a second policy administrator (ACTIVE).
  With no live policy, the replay is recorded as *not applicable*, not as a rate.
  A change above the threshold needs a written justification to request
  approval. The manual transition endpoint can only reopen a proposal; nothing
  can be moved to ACTIVE by hand.
- Editing a tested proposal returns it to RULE_EDIT. Nothing can be edited while
  it awaits approval or is live, including through the advanced rule editor.
  Late-finishing AI analysis re-checks this before it writes.
- Submitting freezes the rules (fingerprint), creates the compiled version and
  queues vectorization. Approval refuses until preparation completes and the
  rules still match the fingerprint.
- Activation is one transaction: registry commit, runtime pointer and active
  flag, approval record, ACTIVE stage, and retirement of the previously live
  proposal. A failure at any step changes none of them.
- `POLICY_REQUIRE_SEPARATE_APPROVER` (default `true`) enforces separation of
  duties. The wizard ends with an approval request; approval happens in the
  proposal drawer, which shows readiness evidence and the version being replaced.
- Proposals can be resumed from the board. Rules are no longer regenerated (and
  manual edits lost) on every return to step 5. Server error explanations are
  shown instead of HTTP status text. The UI reports when an SOP was longer than
  the 12,000 characters analysed. LLM proposals are validated, and an unconfirmed
  "existing" claim is no longer auto-accepted.

Validation: 244 backend unit tests; 16 PostgreSQL integration tests, including
two new end-to-end Policy Studio journeys over HTTP (only the LLM is stubbed)
that cover a failed-activation rollback, separation of duties, editing locks,
rejection and replacement of a live version; migration upgrade → downgrade base
→ upgrade rehearsal; strict TypeScript build; 11 Playwright tests (nginx-only
header test skipped on preview). Coverage floor raised from 34.98% to 36.90%. No production
deployment is included.

Remaining limits, not addressed here:

- **One live policy for the whole runtime.** `kb_runtime_config` is read as a
  single pointer by the Cardinal pipeline, so approving a proposal from any KB
  replaces the policy for all tickets. The approval screen states this. Per-KB
  runtime policies are an architectural change.
- **Live comparison (shadow) is still not evaluated in the pipeline.** Approval
  shows the recorded case count, currently zero. SHADOW_GATE therefore means
  "tested on samples", not "observed live".
- **The replay is an approximation.** The runtime chooses actions with an LLM
  over rule candidates; the replay applies rules first-match. Sample cases carry
  one issue type, so a specific (L2) rule cannot be distinguished from its
  category there.
- **Legacy publication routes remain:** `POST /kb/publish` and `/kb/rollback`
  now require `policy.admin` (previously `knowledgeBase.admin` alone) and record
  the authenticated publisher rather than a client-supplied name, but they still
  activate versions without an approval record. Rollback is kept for emergencies.
  Taxonomy-version approval still only changes its stage. Route these through
  `policy_lifecycle` before relying on the approval trail as a complete control.
- Proposals awaiting approval before this revision must be re-submitted once so
  their runtime preparation is created.
