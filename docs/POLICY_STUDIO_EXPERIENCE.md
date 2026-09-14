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
