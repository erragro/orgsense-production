# Kirana Kart — Refund, Resolution & Quality Policy
**Document ID:** KK-KB-v4.2
**Version:** 4.2
**Status:** Draft — Awaiting PM / Finance / Legal Approval
**Last Updated:** March 2026
**Owner:** Product Management · Finance · Customer Experience
**Applies To:** All inbound support tickets processed by the Cardinal AI Pipeline

---

## Document Purpose

This document defines the **exact business rules** that drive automated ticket resolution,
refund decisions, fraud intervention, and agent quality enforcement in the Kirana Kart
customer support platform. These rules are compiled by the AI rule engine and executed
deterministically on every ticket.

**Changes to these rules directly impact:**
- Customer refund amounts (₹ P&L)
- Fraud exposure and policy-ineligible refunds
- Agent quality scores and coaching triggers
- First-Contact Resolution (FCR) measurement accuracy

---

## Table of Contents

1. [Module 1: Refund Eligibility Policy](#module-1-refund-eligibility-policy)
2. [Module 2: GPS & Delivery Verification](#module-2-gps--delivery-verification)
3. [Module 3: Customer Tier & Loyalty Rules](#module-3-customer-tier--loyalty-rules)
4. [Module 4: Fraud & Abuse Intelligence](#module-4-fraud--abuse-intelligence)
5. [Module 5: Escalation & Approval Matrix](#module-5-escalation--approval-matrix)
6. [Module 6: Agent Quality & QA Standards](#module-6-agent-quality--qa-standards)
7. [Module 7: True FCR & Repeat Contact Policy](#module-7-true-fcr--repeat-contact-policy)
8. [Action Code Registry](#action-code-registry)
9. [Financial Impact Analysis](#financial-impact-analysis)
10. [Approval Sign-offs](#approval-sign-offs)

---

## Module 1: Refund Eligibility Policy

**Module Name:** Resolution Policy (Financial Decision Engine)
**Finance Owner:** CFO Office
**Risk Level:** 🔴 High — Direct P&L Impact

### 1.1 Core Refund Eligibility Rules

**Rule ID:** R-001
**Business Logic:** Refund is ELIGIBLE when delivery failed and GPS confirms no delivery

| Condition | Value | Required |
|-----------|-------|----------|
| `delivery_status` | `failed` OR `undelivered` | ✅ |
| GPS delivery confirmation within 50m of customer address | `false` | ✅ |
| Claim raised within complaint window | ≤ 24 hours | ✅ |

**Action:** `REFUND_FULL`
**Deterministic:** Yes
**Priority:** 10

---

**Rule ID:** R-002
**Business Logic:** Refund is ELIGIBLE for item quality complaints with timely evidence

| Condition | Value | Required |
|-----------|-------|----------|
| Complaint type | `quality` (spoiled / foreign object / wrong order) | ✅ |
| Complaint raised within | ≤ 2 hours of delivery | ✅ |
| Photo/video evidence submitted | `true` | ✅ |

**Action:** `REFUND_FULL` (or `REFUND_PARTIAL` for partial item issues)
**Deterministic:** Yes
**Priority:** 20

---

**Rule ID:** R-003
**Business Logic:** Refund is NOT ELIGIBLE when GPS confirms successful delivery

| Condition | Value |
|-----------|-------|
| `delivery_status` | `delivered` |
| GPS confirmation within 50m of customer address | `true` |

**Action:** `REJECT_NOT_ELIGIBLE`
**Response:** Inform customer that delivery GPS confirms successful drop-off; escalate to human review if customer disputes.
**Deterministic:** Yes
**Priority:** 5 (evaluated before R-001)

---

### 1.2 Refund Amount Matrix

**Rule ID:** R-007
**Business Logic:** Refund percentage scales with issue severity

| Issue Category | Issue Code | Refund % | Fixed Add-on |
|----------------|------------|----------|--------------|
| **Critical** | | | |
| Food Safety | `FOOD_SAFETY_*` | 100% | + ₹100 |
| Foreign Object | `FOREIGN_OBJECT_*` | 100% | + ₹100 |
| Wrong Order (Full) | `WRONG_ORDER_FULL` | 100% | — |
| Veg/Non-Veg Mix | `VEG_NONVEG_MIX` | 100% | + ₹50 |
| Spoiled / Rotten | `QUALITY_SPOILED` | 100% | — |
| **High** | | | |
| Missing Items (Full) | `MISSING_ITEMS_FULL` | 100% | — |
| Severely Late (>SLA) | `DELAY_SEVERE` | 50% | + ₹50 |
| Packaging Leak (Severe) | `PACKAGING_LEAK_SEVERE` | 70% | — |
| **Medium** | | | |
| Missing Items (Partial) | `MISSING_ITEMS_PARTIAL` | 50% | — |
| Quality — Cold | `QUALITY_TEMPERATURE_COLD` | 40% | — |
| Portion Size Small | `QUALITY_PORTION_SMALL` | 30% | — |
| Moderate Delay | `DELAY_MODERATE` | 25% | — |
| **Low** | | | |
| Minor Delay | `DELAY_MINOR` | 10% | — |
| Packaging Dent | `PACKAGING_DENT_MINOR` | 10% | — |
| Approved Substitution | `SUBSTITUTION_APPROVED` | 5% | — |

**Finance Note:** Total annual refund exposure estimated at ₹82.8 Cr across all categories.

---

### 1.3 Compensation Caps

**Rule ID:** R-008
**Business Logic:** Maximum compensation limits by order value range

| Order Value Range | Max Refund | Total Cap | Approval Authority |
|------------------|------------|-----------|-------------------|
| ₹0 – ₹200 | Order value | ₹300 | Auto-approved |
| ₹201 – ₹500 | Order value | ₹650 | Auto-approved |
| ₹501 – ₹1,000 | Order value | ₹1,200 | Auto-approved |
| ₹1,001 – ₹2,000 | Order value | ₹2,250 | Team Lead |
| ₹2,001 – ₹5,000 | Order value | ₹5,300 | Manager |
| ₹5,000+ | Order value | Case-by-case | Senior Manager |

---

## Module 2: GPS & Delivery Verification

**Module Name:** Evidence & Validation Rules
**Operations Owner:** Delivery Ops
**Risk Level:** 🟡 Medium — Fraud Prevention

### 2.1 GPS Confirmation Check

**Rule ID:** GPS-001
**Business Logic:** Cross-check driver GPS coordinates against customer address at time of delivery

| Field | Source | Threshold |
|-------|--------|-----------|
| `gps_lat` / `gps_lng` at delivery event | `delivery_events` table | Within 50 metres |
| Customer address coordinates | `customers.address_lat` / `address_lng` | Reference point |
| `gps_confirmed_delivery` | Computed in Phase 4 enrichment | `true` = within 50m |

**Outcome A (`gps_confirmed_delivery = true`):** Delivery verified → R-003 applies (reject refund unless quality complaint with evidence).
**Outcome B (`gps_confirmed_delivery = false`):** Delivery unconfirmed → R-001 applies (full refund eligible).

**Note:** GPS data must be present in `delivery_events` within the ticket processing window. If GPS record is absent, fall back to `delivery_status` only and route to `MANUAL_REVIEW_GPS_MISSING`.

---

### 2.2 Photo Evidence Validation

**Rule ID:** GPS-002
**Business Logic:** Quality complaints require photo/video within 2-hour window

| Condition | Requirement |
|-----------|-------------|
| Complaint type = `quality` | Evidence required |
| Evidence upload window | ≤ 2 hours from delivery timestamp |
| Missing evidence after 2 hours | Route to `REJECT_EVIDENCE_EXPIRED` |
| Evidence present, within window | Eligible for `REFUND_FULL` or `REFUND_PARTIAL` |

---

## Module 3: Customer Tier & Loyalty Rules

**Module Name:** Customer Tier Policy
**Owner:** Customer Experience / Product
**Risk Level:** 🟡 Medium — Retention Impact

### 3.1 Gold / Platinum One-Click Refund (R-005)

**Rule ID:** R-005
**Business Logic:** Premium tier customers get friction-free resolution on first claim per order

| Condition | Value |
|-----------|-------|
| `customer_tier` | `gold` OR `platinum` |
| Claims on this `order_id` previously | 0 (first claim) |
| Any GPS / fraud pre-checks | Must NOT be flagged as FRAUD |

**Action:** `AUTO_RESOLVED_TIER`
**Refund:** Full order value (up to compensation cap)
**Audit:** Deferred — flagged for batch monthly audit
**Deterministic:** Yes
**Priority:** 15 (evaluated after fraud check, before standard eligibility)

---

### 3.2 Loyalty Multiplier

**Rule ID:** TIER-002
**Business Logic:** Adjust compensation based on customer loyalty

| Customer Attribute | Adjustment |
|-------------------|------------|
| Total orders > 100 | +10% to refund |
| `membership_tier = GOLD` | +15% to refund |
| Complaints in last 30 days > 5 | −20% to refund |
| `fraud_risk_score > 0.7` | −30% to refund |

**Cap:** Final multiplier clamped to [0.5 × base, 1.3 × base]

---

### 3.3 SLA Compensation by Tier

**Rule ID:** TIER-003
**Business Logic:** Delivery delay compensation varies by customer tier

| Tier | Promised SLA | Delay Window | Compensation |
|------|-------------|--------------|-------------|
| Gold / Platinum | 30 min | 31–45 min | ₹50 auto |
| Gold / Platinum | 30 min | 46–60 min | ₹100 auto |
| Gold / Platinum | 30 min | 60+ min | ₹150 + 30% refund |
| Standard | 45 min | 46–60 min | ₹25 auto |
| Standard | 45 min | 61–90 min | ₹50 auto |
| Standard | 45 min | 90+ min | ₹75 + 20% refund |

**Exclusions:** Weather / force majeure events; restaurant-side delay (different matrix).

---

## Module 4: Fraud & Abuse Intelligence

**Module Name:** Fraud & Abuse Intelligence
**Finance Owner:** Finance Fraud Team
**Risk Level:** 🔴 High — ₹12.4 Cr/month leakage

### 4.1 Repeat Refund Threshold (R-004)

**Rule ID:** R-004
**Business Logic:** Customers with excessive refund history require manual review

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Refund requests from same `customer_id` in last 30 days | > 3 | `MANUAL_REVIEW_REPEAT` |
| Refund approval rate > 80% over last 90 days AND total refunds > ₹2,000 | — | `FRAUD_RISK_HOLD` |
| `refund_rate_30d` | > 0.6 | Flag for fraud review |

**Deterministic:** Yes — overrides standard refund approval for flagged customers
**Priority:** 3 (very high — evaluated near first)

---

### 4.2 Bad-Actor Agent Identification

**Rule ID:** FRAUD-002
**Business Logic:** Agents with policy-ineligible refund approval rates are clustered and flagged

| Metric | Threshold | Outcome |
|--------|-----------|---------|
| Policy-ineligible refund approval rate per agent | > 40% in rolling 7 days | `AGENT_FRAUD_FLAG` |
| Suspicious cluster: ≥ 3 agents same BPO / shift | > 60% ineligible rate | `BPO_CLUSTER_ALERT` |

**Target:** Identify bad-actor agents within 4 hours (currently 30-day lag)
**Output:** Written to `agent_quality_flags` table; surfaced via BI Agent daily digest

---

### 4.3 Greedy Fraud Signals

**Rule ID:** FRAUD-003
**Business Logic:** Real-time fraud signals computed per ticket

| Signal | Computation | High-Risk Threshold |
|--------|-------------|---------------------|
| `refund_rate_30d` | Refunds / orders in last 30 days | > 0.5 |
| `complaints_30d` | Complaint count in last 30 days | > 5 |
| `marked_delivered_90d` | Orders marked delivered but disputed | > 3 |
| GPS mismatch on current order | `gps_confirmed_delivery = false` with `delivery_status = delivered` | Any occurrence |

**Any 2+ signals triggered → `greedy_classification = FRAUD` → `REJECT_FRAUD` + `MANUAL_REVIEW_FRAUD`**

---

## Module 5: Escalation & Approval Matrix

**Module Name:** Escalation & Risk Override
**Owner:** Operations
**Risk Level:** 🟡 Medium

### 5.1 Refund Amount Escalation (R-006)

**Rule ID:** R-006
**Business Logic:** High-value refunds require senior agent approval

| Refund Amount | Required Approver | Action Code |
|--------------|-------------------|-------------|
| ≤ ₹500 | Automated — no approval needed | `REFUND_FULL` / `REFUND_PARTIAL` |
| ₹501 – ₹999 | Grade 3+ agent | `ESCALATE_GRADE3` |
| ₹1,000 – ₹1,999 | Team Lead | `ESCALATE_TEAM_LEAD` |
| ₹2,000+ | Manager | `ESCALATE_MANAGER` |

**Deterministic:** Yes
**Priority:** 25 (applied after eligibility confirmed, before final approval)

---

### 5.2 GPS Data Missing

**Rule ID:** ESC-002
**Business Logic:** If GPS record absent from `delivery_events`, human must verify

| Condition | Action |
|-----------|--------|
| `delivery_events` record missing for `order_id` | `MANUAL_REVIEW_GPS_MISSING` |
| Delivery event present but coordinates null | `MANUAL_REVIEW_GPS_MISSING` |

---

## Module 6: Agent Quality & QA Standards

**Module Name:** Agent Quality Intelligence
**Owner:** Quality Assurance / BPO Operations
**Risk Level:** 🟡 Medium — CSAT Impact (4.1 → 3.6 decline)

### 6.1 Canned Response Detection

**Rule ID:** QA-001
**Business Logic:** Flag agents whose responses are excessively templated

| Metric | Measurement | Threshold | Action |
|--------|-------------|-----------|--------|
| Canned response ratio per agent | TF-IDF cosine similarity > 0.92 to known phrases | > 0.30 in any 7-day window | `COACHING_FLAG_CANNED` |
| BPO cluster canned ratio | Aggregate across agents in same BPO / shift cluster | > 0.50 | `BPO_QUALITY_ALERT` |

**Target:** Reduce from 0.61 (Nashik incident) to < 0.30
**Coverage:** 100% of conversations scored within 90 seconds

---

### 6.2 Grammar & Language Quality

**Rule ID:** QA-002
**Business Logic:** Flag agents with excessive grammar errors in customer-facing messages

| Metric | Current | Target | Threshold |
|--------|---------|--------|-----------|
| Grammar errors per 100 words | 3.8 | < 1.5 | > 2.5 triggers flag |

**Action:** `COACHING_FLAG_GRAMMAR`
**Scope:** Agent turns only (not customer or system messages)

---

### 6.3 Sentiment Arc Monitoring

**Rule ID:** QA-003
**Business Logic:** Flag conversations where customer sentiment trajectory is negative throughout

| Signal | Measurement | Threshold |
|--------|-------------|-----------|
| Customer sentiment at conversation end | Sentiment score (−1 to +1) | < −0.3 |
| Sentiment delta (start → end) | End score − start score | < −0.4 (deteriorated) |

**Action:** `COACHING_FLAG_SENTIMENT`
**Scope:** Per conversation; daily aggregate per agent

---

### 6.4 Daily Per-Agent QA Score

**Rule ID:** QA-004
**Business Logic:** Produce a composite daily QA score per agent for coaching

| Component | Weight |
|-----------|--------|
| Canned response ratio (inverse) | 30% |
| Grammar score (inverse error rate) | 30% |
| Sentiment arc score | 40% |

**Score range:** 0.0 – 1.0
**Coaching flag threshold:** < 0.60
**Action:** `COACHING_FLAG_DAILY` — written to `agent_quality_flags` with agent_id, date, score, breakdown
**Target:** Coaching delivered same-day (< 24 hours, currently 3–4 weeks)

---

## Module 7: True FCR & Repeat Contact Policy

**Module Name:** First-Contact Resolution Intelligence
**Owner:** Customer Experience
**Risk Level:** 🟡 Medium — Reported 74% vs True 54%

### 7.1 Async FCR Checker

**Rule ID:** FCR-001
**Business Logic:** 48 hours after resolution, check whether the same customer re-contacted on the same issue

| Condition | Measurement |
|-----------|-------------|
| Resolution window | 48 hours from `resolution_status = resolved` |
| Re-contact match | Same `customer_id` + matching `issue_type_l2` within 48-hour window |
| Re-contact detected | `fcr = false` |
| No re-contact detected | `fcr = true` |

**Action:** Update `fcr` column in `ticket_execution_summary`
**Target:** Raise true FCR from 54% to > 72% over 6 months

---

### 7.2 Intent-Level FCR Breakdown

**Rule ID:** FCR-002
**Business Logic:** Track FCR separately per issue intent to enable targeted coaching

| Issue Intent | Current True FCR | Target |
|-------------|-----------------|--------|
| Refund intent | ~38% | > 60% |
| Delivery intent | ~38% | > 65% |
| Payment / UPI | ~60% | > 75% |
| Product quality | ~55% | > 70% |

**Source:** Computed from `ticket_execution_summary.fcr` grouped by `llm_output_1.issue_type_l2`
**Output:** `GET /analytics/fcr` — True FCR tab in Analytics dashboard

---

## Action Code Registry

> This section is parsed by the Action Code Extractor (`/compiler/extract-actions`).
> Every row below will be upserted into `master_action_codes`.
> `action_code_id` must be SCREAMING_SNAKE_CASE.
> `requires_escalation = true` and `automation_eligible = false` together route tickets to MANUAL_REVIEW.
> `requires_refund = true` routes tickets to HITL for human refund approval.

| action_code_id | action_name | description | requires_refund | requires_escalation | automation_eligible |
|---|---|---|---|---|---|
| `REFUND_FULL` | Full Refund Issued | Issue full order-value refund; GPS or evidence confirms eligibility | true | false | true |
| `REFUND_PARTIAL` | Partial Refund Issued | Issue partial refund based on affected-items matrix | true | false | true |
| `REJECT_NOT_ELIGIBLE` | Refund Rejected — Not Eligible | GPS confirms delivery; claim does not meet eligibility criteria | false | false | true |
| `REJECT_FRAUD` | Refund Rejected — Fraud Detected | Multiple fraud signals triggered; refund zeroed and case escalated | false | true | true |
| `MANUAL_REVIEW_REPEAT` | Manual Review — Repeat Refunder | Customer exceeded repeat-refund threshold (>3 in 30 days); human must decide | false | true | false |
| `MANUAL_REVIEW_FRAUD` | Manual Review — Fraud Risk | Greedy fraud classification triggered; senior agent must review before any action | false | true | false |
| `MANUAL_REVIEW_GPS_MISSING` | Manual Review — GPS Data Absent | No GPS delivery event found in delivery_events; human must verify delivery | false | true | false |
| `FRAUD_RISK_HOLD` | Fraud Risk Hold | High refund rate over 90 days; account held pending senior review | false | true | false |
| `AUTO_RESOLVED_TIER` | Auto-Resolved — Premium Tier | Gold or Platinum first-claim order; auto-approved with deferred monthly audit | true | false | true |
| `ESCALATE_GRADE3` | Escalate — Grade 3 Agent | Refund between Rs. 501 and Rs. 999; requires Grade 3+ agent sign-off before processing | true | true | false |
| `ESCALATE_TEAM_LEAD` | Escalate — Team Lead | Refund between Rs. 1000 and Rs. 1999; requires Team Lead approval | true | true | false |
| `ESCALATE_MANAGER` | Escalate — Manager | Refund Rs. 2000 or above; requires Manager approval before processing | true | true | false |
| `REJECT_EVIDENCE_EXPIRED` | Rejected — Evidence Window Expired | Quality complaint raised after the 2-hour photo evidence window; no refund issued | false | false | true |
| `COACHING_FLAG_CANNED` | Coaching Flag — Canned Responses | Agent canned-response ratio exceeded 0.30 threshold in 7-day window | false | false | true |
| `COACHING_FLAG_GRAMMAR` | Coaching Flag — Grammar Errors | Agent grammar error rate exceeded 2.5 per 100 words in agent turns | false | false | true |
| `COACHING_FLAG_SENTIMENT` | Coaching Flag — Negative Sentiment | Conversation sentiment deteriorated; customer sentiment delta below -0.4 | false | false | true |
| `COACHING_FLAG_DAILY` | Daily Coaching Flag | Composite daily QA score below 0.60 threshold; coaching packet generated | false | false | true |
| `BPO_QUALITY_ALERT` | BPO Cluster Quality Alert | BPO cluster aggregate canned-response ratio exceeded 0.50; team lead notified | false | true | true |
| `AGENT_FRAUD_FLAG` | Agent Fraud Behaviour Flag | Agent policy-ineligible approval rate exceeded 40% in rolling 7 days | false | true | true |
| `BPO_CLUSTER_ALERT` | BPO Cluster Fraud Alert | Three or more agents in same BPO or shift with over 60% ineligible approval rate | false | true | true |

---

## Financial Impact Analysis

| Business Problem | Monthly Leakage / Cost | Target Reduction | Expected Saving |
|-----------------|----------------------|-----------------|----------------|
| Policy-ineligible refunds (P1) | ₹12.4 Cr / month | 40–60% | ₹5–7.4 Cr / month |
| QA labour cost (P2) | 1,200 manual reviews / week | 5× coverage at 80% lower cost | ~₹40L / month |
| Spike investigation lag (P3) | 3-day lag × 2.2M chats/month | < 2 hours detection | Indirect: CSAT / brand |
| FCR gap (P4) | 220,000 repeat contacts / month | True FCR 54% → 72% | ~₹1.5 Cr / month |

**Total addressable monthly leakage: ~₹14 Cr+**

---

## Approval Sign-offs

| Role | Owner | Approval Status | Date |
|------|-------|----------------|------|
| Product Management | — | ⬜ Pending | — |
| Finance (CFO Office) | — | ⬜ Pending | — |
| Legal / Compliance | — | ⬜ Pending | — |
| Operations | — | ⬜ Pending | — |
| Customer Experience | Priya Menon, VP CX | ⬜ Pending | — |

---

*All companies, persons, events, and metrics in this document are entirely fictional and for demonstration purposes only.*
