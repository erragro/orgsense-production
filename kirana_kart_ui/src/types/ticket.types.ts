export interface FdrawTicket {
  sl: number
  ticket_id: number
  group_id: string
  group_name: string | null
  cx_email: string | null
  status: number
  subject: string | null
  description: string | null
  created_at: string | null
  updated_at: string | null
  tags: string | null
  code: string | null
  img_flg: number
  attachment: number
  processed: number
  ts: string
  pipeline_stage: string
  source: string
  module: string | null
  canonical_payload: unknown
  detected_language: string | null
  preprocessed_text: string | null
  processing_state?: Pick<TicketProcessingState, 'current_stage' | 'stage_0_status' | 'stage_1_status' | 'stage_2_status' | 'stage_3_status'>
}

export interface LLMOutput1 {
  id: number
  ticket_id: number
  order_id: string | null
  issue_type_l1: string | null
  issue_type_l2: string | null
  confidence_entailment: number | null
  confidence_db_match: number | null
  image_required: boolean
  image_fetched: boolean
  db_issue_type: string | null
  db_issue_match: boolean
  vector_top_match_l1: string | null
  vector_top_match_l2: string | null
  vector_similarity_score: number | null
  reasoning: string | null
  status: number
  created_at: string
  execution_id: string | null
  execution_type: string | null
  is_complete: boolean
  pipeline_status: string
  module: string | null
}

export interface LLMOutput2 {
  id: number
  ticket_id: number
  order_id: string | null
  llm_output_1_id: number | null
  issue_type_l1_original: string | null
  issue_type_l2_original: string | null
  issue_type_l1_verified: string | null
  issue_type_l2_verified: string | null
  issue_changed: boolean
  fraud_segment: string | null
  value_segment: string | null
  standard_logic_passed: boolean | null
  aon_bod_eligible: boolean
  super_subscriber: boolean
  hrx_applicable: boolean
  hrx_passed: boolean | null
  greedy_classification: string
  sla_breach: boolean | null
  delivery_delay_minutes: number | null
  multiplier: number | null
  order_value: number | null
  calculated_gratification: number | null
  capped_gratification: number | null
  cap_applied: string | null
  action_code: string | null
  action_code_id: string | null
  action_description: string | null
  overall_confidence: number | null
  decision_reasoning: string | null
  status: number
  created_at: string
  execution_id: string | null
  is_complete: boolean
  pipeline_status: string
  module: string | null
}

export interface LLMOutput3 {
  id: number
  ticket_id: number
  order_id: string | null
  llm_output_2_id: number | null
  final_action_code: string | null
  final_action_name: string | null
  final_refund_amount: number | null
  logic_validation_status: string | null
  automation_pathway: string | null
  cap_applied_flag: boolean
  history_check_flag: boolean
  discrepancy_detected: boolean
  discrepancy_count: number
  discrepancy_details: string | null
  discrepancy_severity: string | null
  override_applied: boolean
  override_reason: string | null
  detailed_reasoning: string | null
  freshdesk_status: number | null
  freshdesk_code: string | null
  is_synced: number
  created_at: string
  execution_id: string | null
  is_complete: boolean
  pipeline_status: string
  policy_version: string | null
  policy_artifact_hash: string | null
  decision_trace: unknown
  module: string | null
}

export interface TicketProcessingState {
  id: number
  ticket_id: number
  execution_id: string | null
  current_stage: number
  stage_0_status: string
  stage_1_status: string
  stage_2_status: string
  stage_3_status: string
  stage_0_completed_at: string | null
  stage_1_completed_at: string | null
  stage_2_completed_at: string | null
  stage_3_completed_at: string | null
  claimed_by: string | null
  processing_started_at: string | null
  processing_completed_at: string | null
  error_message: string | null
  retry_count: number
  created_at: string
  module: string | null
}

export interface ExecutionMetrics {
  id: number
  execution_id: string | null
  ticket_id: number | null
  start_at: string | null
  end_at: string | null
  duration_ms: number | null
  llm_1_tokens: number | null
  llm_2_tokens: number | null
  llm_3_tokens: number | null
  total_tokens: number | null
  overall_status: string | null
  created_at: string
}

export interface TicketDetail extends FdrawTicket {
  processing_state?: TicketProcessingState
  llm_output_1?: LLMOutput1
  llm_output_2?: LLMOutput2
  llm_output_3?: LLMOutput3
  execution_metrics?: ExecutionMetrics
}

export interface IngestResponse {
  execution_id: string
  ticket_id?: number
  status: 'accepted' | 'duplicate' | 'rejected'
  message: string
  is_sandbox: boolean
  received_at: string
}

export interface CardinalIngestPayload {
  channel: string
  source: string
  org: string
  business_line: string
  module: string
  payload: {
    cx_email?: string
    customer_id?: string
    subject: string
    description: string
    order_id?: string
  }
  metadata?: {
    environment?: string
    called_by?: string
    test_mode?: boolean
    reprocess?: boolean
  }
}
