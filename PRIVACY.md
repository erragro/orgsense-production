# Privacy & Data Governance — Kirana Kart

**Engineering review**: 2026-09-13

> **Draft policy, not deployment evidence or legal approval.** The legal,
> processor, localisation, and contact assertions below require review by the
> organisation. No production rotation, restore drill, region verification, or
> processor agreement was performed by this hardening change. See
> [the control evidence register](docs/CONTROL_EVIDENCE.md) for tested scope.

**Last Updated**: 2026-03-29
**Applicable Law**: Digital Personal Data Protection (DPDP) Act, 2023 (India)
**Data Controller**: Kirana Kart (the "Organisation")

---

## 1. Data Protection Officer (DPO)

As required under the DPDP Act for significant data fiduciaries:

| Field | Details |
|-------|---------|
| DPO Name | [To be appointed] |
| DPO Email | dpo@kirana.com |
| Grievance Officer | grievance@kirana.com |
| Response target | 30 days (operational target; legal deadline requires review) |
| Address | [Registered office address, India] |

All data subject rights requests (access, erasure, portability, correction, grievance)
should be submitted via:
- **In-app**: Settings → Data Rights → Submit Request
- **API**: `POST /data-rights/grievance`
- **Email**: dpo@kirana.com

---

## 2. Data Processing Register

| Data Category | Purpose | Legal Basis | Retention | Processor |
|--------------|---------|-------------|-----------|-----------|
| User email, name | Account management | Consent (DPDP §6) | Account lifetime | Internal DB |
| Customer email, phone, DOB | Order processing, CRM | Consent (DPDP §6) | 3 years then anonymise |Internal DB |
| Order records | Financial audit, SLA | Legitimate interest / Legal | 7 years (tax law) | Internal DB |
| Conversation transcripts | Support, quality | Consent | 1 year then delete | Internal DB |
| CSAT feedback | Product improvement | Consent | 2 years then delete | Internal DB |
| Auth tokens | Security | Necessary for service | 30 days | Redis (in-memory) |
| PII access logs | Security audit | Legitimate interest | 1 year then delete | Internal DB |
| OAuth profile (email, avatar) | Single sign-on | Consent | Account lifetime | GitHub / Google / Microsoft |
| LLM context | AI responses | Consent | Not retained (API call only) | OpenAI API |
| Telemetry traces | Observability | Legitimate interest | 15 days | Jaeger (internal) |

---

## 3. Third-Party Data Processors

| Processor | Data Shared | Purpose | DPA Status |
|-----------|------------|---------|------------|
| OpenAI (openai.com) | Order context, support text | AI pipeline | Pending DPA |
| GitHub (oauth) | Email, avatar, OAuth ID | SSO | GitHub ToS / DPA |
| Google (oauth + email) | Email, avatar, OAuth ID, inbox | SSO + email integration | Google DPA |
| Microsoft (oauth + outlook) | Email, OAuth ID, inbox | SSO + email integration | Microsoft DPA |
| Freshdesk | Ticket data, customer email | CRM integration | Pending DPA |

**Action Required**: Execute formal Data Processing Agreements (DPAs) with all
processors listed as "Pending DPA" before handling production data at scale.

---

## 4. Data Subject Rights

Under DPDP Act §§13-14, data principals have the following rights:

| Right | How to Exercise | Response SLA |
|-------|----------------|--------------|
| Right to access | `GET /data-rights/users/me/export` | Immediate |
| Right to correction | Contact dpo@kirana.com | 30 days |
| Right to erasure | `DELETE /data-rights/users/me` | Immediate |
| Right to portability | `GET /data-rights/users/me/export` | Immediate |
| Right to withdraw consent | `POST /consent/withdraw` | Immediate |
| Grievance redressal | `POST /data-rights/grievance` | 30 days |

---

## 5. Children's Data (DPDP Act §9)

- Users under 18 years of age require verifiable parental/guardian consent.
- The `guardian_consent_given` field on the `users` table tracks this.
- Signup flow blocks accounts where DOB indicates age < 18 without guardian consent.
- No behavioural advertising or profiling of children's data is performed.

---

## 6. Data Localisation

- All personal data of Indian data principals is stored in India.
- Primary database: PostgreSQL — deployed in `ap-south-1` (Mumbai) or equivalent Indian region.
- Redis cache: same region.
- Backups: same region, encrypted at rest.
- `DATA_REGION=IN` config assertion enforced at startup in production.

---

## 7. Security Measures

As required by DPDP Act §8(5) ("reasonable security safeguards"):

- **Encryption in transit**: TLS 1.2+ for all external connections
- **Customer identity encryption**: AES-256-GCM for `customers.email`, `phone`, and `date_of_birth` after migration and verified backfill. This does not encrypt every copy of PII in tickets, CRM, user profiles, free text, exports, or backups.
- **Access control**: JWT-based RBAC with per-module permissions
- **Account lockout**: 5 failed login attempts → 15-min lockout
- **Audit logging**: Customer list/detail access is recorded in `pii_access_log`. Coverage of other PII-bearing endpoints is not yet comprehensive.
- **Data retention**: A Celery Beat sweep handles customer identity, conversation turns, CSAT, audit logs, and expired refresh tokens. Schedule deployment and execution must be verified.
- **Secrets management**: Environment variables + secret manager (no hardcoded credentials)
- **Dependency scanning**: Automated `pip-audit` + `npm audit` in CI

---

## 8. Breach Notification

Under DPDP Act §8(6), the Organisation will notify:
1. The Data Protection Board of India (when constituted)
2. Affected data principals

...within the timeframe prescribed by DPDP Rules (to be notified by the Government).

Internal breach response procedures are documented separately in the Security Runbook.

---

## 9. Significant Data Fiduciary Assessment

The Organisation will assess whether it qualifies as a "Significant Data Fiduciary"
under DPDP Act §10 based on:
- Volume and sensitivity of personal data processed
- Risk to rights of data principals
- National security implications

If designated, additional obligations apply including:
- Data Protection Impact Assessment (DPIA)
- Periodic audits by independent data auditor
- Appointment of DPO (India-resident)

---

*This document is maintained by the Engineering and Legal teams. Update on every
material change to data processing activities.*
