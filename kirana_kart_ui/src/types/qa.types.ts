// ─── QA Agent Types ───────────────────────────────────────────────────────────

export interface MLCheckResult {
  name: string
  score: number
  weight: number
  pass: boolean
  finding: string
  source: 'ml'
}

export interface DismissedFlag {
  parameter_name: string
  original_score: number
  override_reason: string
  overridden_at: string
}

export interface PythonCheckResult {
  name: string
  category: 'Accuracy' | 'Financial' | 'Compliance' | 'Operational' | 'Quality' | 'Risk' | 'Cost'
  standard_ref: string
  score: number
  weight: number
  pass: boolean
  value_observed: string
  threshold: string
  finding: string
  method: 'python_deterministic'
}

export interface PythonSummary {
  python_score: number
  python_grade: string
  python_pass_count: number
  python_fail_count: number
}

export interface QASession {
  id: number
  label: string
  created_at: string
  updated_at: string
}

export interface QATicketResult {
  ticket_id: number
  subject: string
  module: string
  cx_email: string
  ticket_created_at: string
  issue_type_l1: string | null
  issue_type_l2: string | null
  action_code: string | null
  overall_confidence: number | null
  processing_completed_at: string
  stage_0_status: string
  stage_1_status: string
  stage_2_status: string
  stage_3_status: string
}

export interface QAParameterResult {
  name: string
  score: number
  weight: number
  finding: string
  recommendation: string
  pass: boolean
}

export interface QASummary {
  overall_score: number
  grade: string
  pass_count: number
  warn_count: number
  fail_count: number
  audit_narrative: string
}

export interface KBRule {
  rule_id: string
  module_name: string
  rule_type: string
  action_code_id: string
  action_name: string
  semantic_text: string
}

export interface KBIssue {
  issue_code: string
  label: string
  description: string
  level: number
  semantic_text: string
}

export interface KBAction {
  action_code_id: string
  action_name: string
  action_description: string
  requires_refund: boolean
  requires_escalation: boolean
  automation_eligible: boolean
  semantic_text: string
}

export interface KBEvidence {
  rules: KBRule[]
  issues: KBIssue[]
  actions: KBAction[]
}

export interface QAEvaluationSummary {
  id: number
  ticket_id: number
  ticket_subject: string | null
  ticket_module: string | null
  issue_type_l1: string | null
  issue_type_l2: string | null
  action_code: string | null
  overall_score: number | null
  grade: string | null
  status: string
  created_at: string
  completed_at: string | null
}

export interface QAEvaluation extends QAEvaluationSummary {
  session_id: number
  execution_id: string | null
  classification_score: number | null
  policy_compliance_score: number | null
  confidence_score: number | null
  gratification_score: number | null
  sla_score: number | null
  discrepancy_score: number | null
  response_quality_score: number | null
  kb_alignment_score: number | null
  override_score: number | null
  fraud_score: number | null
  overall_confidence: number | null
  findings: QAParameterResult[] | null
  kb_evidence: KBEvidence | null
  python_qa_score: number | null
  python_findings: PythonCheckResult[] | null
  error_message: string | null
}

export type QASSEEventType =
  | 'status'
  | 'kb_evidence'
  | 'python_check'
  | 'python_summary'
  | 'ml_check'
  | 'parameter'
  | 'summary'
  | 'done'
  | 'error'

export interface QASSEEvent {
  type: QASSEEventType
  // status
  text?: string
  // kb_evidence
  rules?: KBRule[]
  issues?: KBIssue[]
  actions?: KBAction[]
  // parameter
  name?: string
  score?: number
  weight?: number
  finding?: string
  recommendation?: string
  pass?: boolean
  // summary
  overall_score?: number
  grade?: string
  pass_count?: number
  warn_count?: number
  fail_count?: number
  audit_narrative?: string
  // python_check fields
  category?: string
  standard_ref?: string
  value_observed?: string
  threshold?: string
  method?: string
  // python_summary fields
  python_score?: number
  python_grade?: string
  python_pass_count?: number
  python_fail_count?: number
  // done
  evaluation_id?: number | null
}

export interface TicketSearchParams {
  ticket_id?: number
  module?: string
  date_from?: string
  date_to?: string
  limit?: number
}
