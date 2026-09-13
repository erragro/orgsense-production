export interface DailyMetric {
  date: string
  count: number
  value?: number
}

export interface AnalyticsSummary {
  total_tickets: number
  avg_duration_ms: number
  p95_duration_ms: number
  auto_resolution_rate: number
  avg_csat: number
  sla_breach_rate: number
  total_refund_amount: number
  tickets_by_module: Record<string, number>
  daily_ticket_counts: DailyMetric[]
  csat_trend: DailyMetric[]
  refund_by_day: DailyMetric[]
  action_code_distribution: Record<string, number>
}

export interface RefundRecord {
  refund_id: number
  ticket_id: number
  order_id: string
  refund_amount: number
  applied_action_code: string
  refund_reason: string | null
  refund_source: string | null
  processed_at: string
}

export interface EvaluationRecord {
  ticket_id: number
  order_id: string | null
  customer_id: string | null
  created_at: string | null
  module: string | null
  pipeline_stage: string | null

  source_issue_l1: string | null
  source_fraud_segment: string | null
  source_value_segment: string | null
  source_clm_segment: string | null
  source_complaint_amount: number | null
  source_order_value: number | null
  source_total_order_value: number | null
  source_cust_lifetime_orders: number | null
  source_cust_igcc_req_per_60d: number | null
  source_cust_igcc_granted_per_60d: number | null
  source_cust_exceptions_count_60d: number | null
  source_cust_lifetime_igcc_claims_per: number | null
  source_cust_igcc_claims_per_6m: number | null
  source_cust_igcc_given_per_6m: number | null
  source_last_5_igcc_orders_same_disposition: number | null
  source_last_5_orders_with_igcc: number | null
  source_average_igcc_frequency: number | null
  source_hrx_flag: number | null
  source_ofo_flag: number | null
  source_gallery_upload_gt_camera_upload: number | null
  source_rest_igcc_granted_per_7d: number | null
  source_aon: number | null

  eval_issue_l1: string | null
  eval_issue_l2: string | null
  eval_standard_logic_passed: boolean | null
  eval_lifetime_igcc_check: boolean | null
  eval_exceptions_60d_check: boolean | null
  eval_igcc_history_check: boolean | null
  eval_same_issue_check: boolean | null
  eval_aon_bod_eligible: boolean | null
  eval_greedy_signals_count: number | null
  eval_greedy_classification: string | null
  eval_hrx_applicable: boolean | null
  eval_hrx_passed: boolean | null
  eval_multiplier: number | null
  eval_order_value: number | null
  eval_calculated_gratification: number | null
  eval_capped_gratification: number | null
  eval_cap_applied: string | null
  eval_action_code: string | null
  eval_action_code_id: string | null
  eval_overall_confidence: number | null
  eval_evaluation_confidence: number | null
  eval_action_confidence: number | null
  eval_model_used: string | null

  val_standard_logic: boolean | null
  val_greedy_check: boolean | null
  val_multiplier_check: boolean | null
  val_cap_check: boolean | null
  val_multiplier: number | null
  val_capped_gratification: number | null
  val_greedy_classification: string | null
  val_llm_accuracy: number | null
  val_discrepancy_detected: boolean | null
  val_discrepancy_severity: string | null
  val_override_applied: boolean | null
  val_override_type: string | null
  val_automation_pathway: string | null
  val_final_action_code: string | null
  val_final_refund_amount: number | null
}

export interface EvaluationFilters {
  modules: string[]
  issue_l1: string[]
  issue_l2: string[]
  fraud_segments: string[]
  value_segments: string[]
  action_codes: string[]
  automation_pathways: string[]
  greedy_classifications: string[]
  pipeline_stages: string[]
}

export interface EvaluationResponse {
  items: EvaluationRecord[]
  page: number
  limit: number
  total: number
  total_pages: number
}
