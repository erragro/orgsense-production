export interface KBRawUpload {
  id: number
  document_id: string
  original_filename: string
  original_format: string
  raw_content: string
  upload_status: string
  uploaded_by: string | null
  uploaded_at: string
  compile_errors: unknown | null
  compiled_hash: string | null
  markdown_content: string | null
  version_label: string
  is_active: boolean
  registry_status: string
  updated_at: string
}

export interface KBVersion {
  id: number
  version_label: string
  status: string
  created_by: string | null
  created_at: string
  snapshot_data: unknown
}

export interface KBDraft {
  id: number
  document_id: string
  title: string
  domain: string
  category: string
  subcategory: string | null
  content: string
  risk_level: string
  auto_resolution_allowed: boolean
  escalation_required: boolean
  linked_issue_codes: string[]
  version_label: string
  created_at: string
  updated_at: string
}

export interface KBActiveVersion {
  active_version: string
  activated_at: string
}

export interface KBUploadPayload {
  document_id: string
  original_filename: string
  original_format: string
  raw_content: string
  uploaded_by: string
  version_label: string
}

export interface CompilerStatus {
  version_label: string
  status: string
  policy_version?: string
  artifact_hash?: string
  is_active?: boolean
  error?: string
}

export interface VectorJob {
  id: number
  version_label: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  created_at: string
  started_at: string | null
  completed_at: string | null
  error: string | null
}

export interface ActionCode {
  id: number
  action_key: string
  action_code_id: string
  action_name: string
  action_description: string | null
  requires_refund: boolean
  requires_escalation: boolean
  automation_eligible: boolean
}

export interface RuleEntry {
  id: number
  rule_id: string
  policy_version: string
  module_name: string
  rule_type: string
  priority: number
  rule_scope: string | null
  issue_type_l1: string | null
  issue_type_l2: string | null
  business_line: string | null
  customer_segment: string | null
  fraud_segment: string | null
  min_order_value: number | null
  max_order_value: number | null
  min_repeat_count: number | null
  max_repeat_count: number | null
  sla_breach_required: boolean
  evidence_required: boolean
  conditions: Record<string, unknown>
  action_id: number
  action_code_id: string
  action_name: string
  action_payload: Record<string, unknown>
  deterministic: boolean
  overrideable: boolean
}

export interface ExtractActionsResult {
  extracted: ActionCode[]
  inserted_count: number
  total_count: number
}
