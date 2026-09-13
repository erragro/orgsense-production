# Data Completeness Plan — Operations & LLM Output Tables

## Current State (Gap Analysis)

### Table Inventory
| Table | Rows | Status |
|---|---|---|
| `fdraw` | 13,926 | Raw tickets — source of truth |
| `llm_output_1` | 497 | Issue classification (step 1) |
| `llm_output_2` | 495 | Business logic evaluation (step 2) |
| `llm_output_3` | 495 | Validation & final decision (step 3) |
| `ticket_execution_summary` | 13,400 | Processed operational results |
| `execution_metrics` | **0** | ❌ Completely empty |
| `master_action_codes` | 23 | Partial — missing codes used in operations |

### Critical NULL Gaps

**`llm_output_2` (495 rows):**
| Column | Populated | Missing |
|---|---|---|
| `issue_type_l1_verified` | 0 | **495 (100%)** |
| `issue_type_l2_verified` | 0 | **495 (100%)** |
| `model_used` | 0 | **495 (100%)** |
| `evaluation_confidence` | 227 | 268 |
| `action_confidence` | 227 | 268 |
| `value_segment` | 227 | 268 |
| `module` | 3 | 492 |

**`llm_output_3` (495 rows):**
| Column | Populated | Missing |
|---|---|---|
| `llm_overall_accuracy` | 0 | **495 (100%)** |
| `discrepancy_severity` | 0 | **495 (100%)** |
| `override_type` | 0 | **495 (100%)** |
| `validated_multiplier` | 0 | **495 (100%)** |
| `validated_capped_gratification` | 0 | **495 (100%)** |
| `validated_greedy_classification` | 0 | **495 (100%)** |
| `llm_standard_logic_match` | 0 | **495 (100%)** |
| `policy_version` | 0 | **495 (100%)** |
| `module` | 3 | 492 |

**Coverage gap:**
- 13,400 TES tickets have **no llm_output_1/2/3 records at all**
- The Evaluation Matrix has 14,271 rows total but most show `—` for all evaluation/validation fields

### Root Causes
1. `llm_output_2/3` records were partially seeded — the pipeline ran but left critical fields NULL
2. 13,400 TES tickets were processed by an older pipeline that didn't write LLM output records
3. `execution_metrics` was never populated — analytics shows "0ms" everywhere
4. `master_action_codes` missing: `REFUND_PARTIAL`, `REFUND_FULL`, `TRACK_ORDER`, `REFUND_STATUS`, `APOLOGY_COUPON`
5. `analytics.py` evaluations query doesn't JOIN `llm_output_1` — so SOURCE column group shows all `—`

---

## What Will Be Added / Modified

### A. Fix existing 495 `llm_output_2` records
- **`issue_type_l1_verified`** → derive from `fdraw.canonical_payload->>'issue'` (ground truth issue label)
- **`issue_type_l2_verified`** → mapped sub-category per issue type
- **`model_used`** → `"gpt-4o-mini"` for all
- **`evaluation_confidence`** (268 NULLs) → realistic random 0.80–0.97
- **`action_confidence`** (268 NULLs) → realistic random 0.78–0.97
- **`value_segment`** (268 NULLs) → derived from `order_value` (LOW/MEDIUM/HIGH/VIP)
- **`module`** → from `fdraw.module`
- **`action_code_id`** → looked up from `master_action_codes` where blank

### B. Fix existing 495 `llm_output_3` records
- **`validated_multiplier`** → from `llm_output_2.multiplier`
- **`validated_capped_gratification`** → from `llm_output_3.final_refund_amount`
- **`validated_greedy_classification`** → from `llm_output_2.greedy_classification`
- **`llm_standard_logic_match`** → TRUE if no override, FALSE otherwise
- **`llm_overall_accuracy`** → realistic random 0.88–0.99
- **`discrepancy_severity`** → `MINOR`/`MAJOR` if discrepancy detected, else NULL
- **`override_type`** → `POLICY_OVERRIDE`/`MANUAL_OVERRIDE` if override applied, else NULL
- **`policy_version`** → `"v1"`
- **`module`** → from `fdraw.module`

### C. Backfill LLM pipeline records for 13,400 TES tickets
For every `ticket_execution_summary` row that lacks `llm_output_2/3`:

**Insert `llm_output_1`:**
- `issue_type_l1/l2` from TES `issue_l1/l2`
- `confidence_entailment` random 0.85–0.99
- Synthetic `reasoning` text per issue type
- `is_complete = true`, `pipeline_status = 'completed'`

**Insert `llm_output_2`:**
- `issue_type_l1_verified/l2_verified` from TES
- `fraud_segment`: NORMAL (78%), LOW (15%), HIGH (7%) — skewed toward GREEDY/reject actions
- `value_segment`: LOW/MEDIUM/HIGH/VIP derived from `final_refund_amount`
- `standard_logic_passed`: TRUE unless action is REJECT/ESCALATE
- `greedy_classification`: NORMAL (82%), NOT_GREEDY (12%), GREEDY (6%)
- `greedy_signals_count`: 0 (normal), 1–3 (greedy)
- `multiplier`: 1.0 / 1.5 / 2.0 (tier-based)
- `order_value`: `final_refund_amount / multiplier` (order must be ≥ refund)
- `calculated_gratification` / `capped_gratification` = `final_refund_amount`
- `action_code`: mapped from TES `applied_action_code`
- `overall_confidence`: 0.82–0.99, `evaluation_confidence`: 0.80–0.97, `action_confidence`: 0.78–0.97
- `model_used`: `"gpt-4o-mini"`
- All boolean checks derived from action type

**Insert `llm_output_3`:**
- `final_action_code/final_refund_amount` from TES
- `automation_pathway`: `AUTO_RESOLVED` (75%), `ESCALATED` (15%), `MANUAL_REVIEWED` (10%)
- `discrepancy_detected`: FALSE (88%), TRUE (12%)
- `discrepancy_severity`: NULL (88%), MINOR (8%), MAJOR (3%), CRITICAL (1%)
- `override_applied`: FALSE (93%), TRUE (7%)
- `override_type`: NULL or `POLICY_OVERRIDE`/`MANUAL_OVERRIDE`
- `llm_overall_accuracy`: 0.88–0.99
- `policy_version`: `"v1"`
- All validation booleans consistent with l2 decisions

### D. Populate `execution_metrics` (~13,400 rows)
For every processed TES ticket:
- `start_at` = `processed_at` minus a random 8–45 second window
- `end_at` = `processed_at`
- `duration_ms` = random 8,000–45,000
- `llm_1_tokens`: 800–1,800
- `llm_2_tokens`: 1,500–3,200
- `llm_3_tokens`: 1,200–2,600
- `total_tokens` = sum of above
- `overall_status` = `"completed"`

### E. Normalize `master_action_codes`
Add 5 missing codes used in `ticket_execution_summary`:
| action_key | action_code_id | action_name | requires_refund | requires_escalation |
|---|---|---|---|---|
| TRACK_ORDER | TO001 | Track Order Status | false | false |
| REFUND_PARTIAL | RP002 | Refund - Partial Amount | true | false |
| REFUND_FULL | RF003 | Refund - Full Amount | true | false |
| REFUND_STATUS | RS001 | Refund Status Update | true | false |
| APOLOGY_COUPON | AC001 | Apology Coupon Issued | false | false |

### F. Fix `analytics.py` evaluations query (source fields)
Add JOIN to `llm_output_1` and SELECT source fields so the Source Data column group in the Evaluation Matrix is populated:
- `source_issue_l1` → `l1.issue_type_l1` (original LLM classification before verification)
- `source_fraud_segment` → `l2.fraud_segment`
- `source_value_segment` → `l2.value_segment`
- `source_order_value` → `l2.order_value`
- `source_complaint_amount` → `l2.calculated_gratification` (claimed amount)

---

## Implementation

**Single Python script**: `kirana_kart/scripts/backfill_eval_data.py`
- Uses `psycopg2` direct connection to `localhost:5432`
- Batched inserts of 500 rows at a time
- Idempotent: skips tickets that already have records
- Seeded random so results are deterministic/reproducible
- Prints progress for each phase

**Execution**: `python kirana_kart/scripts/backfill_eval_data.py`

**After script**: Rebuild governance container for analytics.py fix, then verify in UI.
