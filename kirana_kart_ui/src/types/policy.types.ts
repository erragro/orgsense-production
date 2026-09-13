export interface PolicyVersion {
  policy_version: string
  description: string | null
  activated_at: string | null
  is_active: boolean
  artifact_hash: string | null
  vector_collection: string | null
  created_at: string
  vector_status: string
}

export interface RuleRegistry {
  id: number
  rule_id: string
  policy_version: string
  module_name: string
  rule_type: string
  priority: number
  rule_scope: string
  filters: Record<string, unknown>
  numeric_constraints: Record<string, unknown>
  flags: Record<string, unknown>
  conditions: Record<string, unknown>
  action_id: number
  action_payload: Record<string, unknown>
  overrideable: boolean
  created_at: string
  issue_type_l1: string | null
  issue_type_l2: string | null
  business_line: string | null
  customer_segment: string | null
  fraud_segment: string | null
  min_order_value: number | null
  max_order_value: number | null
  deterministic: boolean
}

export interface MasterActionCode {
  id: number
  action_key: string
  action_code_id: string
  action_name: string | null
  action_description: string | null
  freshdesk_status: number | null
  freshdesk_status_name: string | null
  requires_refund: boolean
  requires_escalation: boolean
  automation_eligible: boolean
  created_at: string
}

export interface SimulationRun {
  id: number
  policy_version: string | null
  baseline_version: string | null
  tickets_processed: number | null
  differences_found: number | null
  created_at: string
}

export interface SimulationResult {
  id: number
  run_id: number | null
  ticket_id: string | null
  baseline_action: string | null
  candidate_action: string | null
  changed: boolean | null
}

export interface SimulationRunPayload {
  baseline_version: string
  candidate_version: string
}

export interface ShadowStats {
  shadow_version: string | null
  active_version: string | null
  total_evaluated: number
  decisions_changed: number
  change_rate: number
  is_active: boolean
}

export interface ShadowResult {
  id: number
  ticket_id: string | null
  active_policy_version: string | null
  candidate_policy_version: string | null
  active_action_code: string | null
  shadow_action_code: string | null
  decision_changed: boolean | null
  created_at: string
}

export interface PolicyShadowEnablePayload {
  shadow_version: string
}
