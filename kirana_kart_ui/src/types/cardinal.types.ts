// src/types/cardinal.types.ts
// TypeScript interfaces for the Cardinal Intelligence module.

export interface CardinalTotals {
  all_time: number
  today: number
  last_7d: number
}

export interface CardinalRates {
  auto_resolution_pct: number
  dedup_pct: number
  phase_failure_pct: number
}

export interface VolumeTrendPoint {
  date: string
  count: number
}

export interface DistributionItem {
  source?: string
  channel?: string
  count: number
}

export interface CardinalOverview {
  totals: CardinalTotals
  rates: CardinalRates
  avg_processing_ms: number
  volume_trend: VolumeTrendPoint[]
  source_distribution: DistributionItem[]
  channel_distribution: DistributionItem[]
}

export interface PhaseTopError {
  message: string
  count: number
}

export interface PhaseStats {
  stage: string
  phase: number
  name: string
  processed: number
  passed: number
  failed: number
  error_rate_pct: number
  avg_latency_ms: number
  top_errors: PhaseTopError[]
  type: 'cardinal_phase' | 'llm_stage'
}

export interface ExecutionSummary {
  ticket_id: string
  cx_email: string
  subject: string
  source: string
  module: string
  created_at: string | null
  status: string
  processing_ms: number | null
  action_code: string | null
  issue_l1: string | null
  issue_l2: string | null
}

export interface ExecutionsResponse {
  items: ExecutionSummary[]
  total: number
  page: number
  pages: number
}

export interface ExecutionDetail {
  raw_ticket: Record<string, unknown> | null
  execution_plan: Record<string, unknown> | null
  phase_states: Record<string, unknown>[]
  llm_output_1: Record<string, unknown> | null
  llm_output_2: Record<string, unknown> | null
  llm_output_3: Record<string, unknown> | null
  summary: Record<string, unknown> | null
  metrics: Record<string, unknown> | null
  audit_events: Record<string, unknown>[]
}

export interface AuditEvent {
  id: number
  execution_id: string | null
  ticket_id: string | null
  stage_name: string | null
  event_time: string | null
  event_type: string | null
  message: string | null
  metadata: Record<string, unknown> | null
}

export interface AuditResponse {
  items: AuditEvent[]
  total: number
  page: number
  pages: number
}

export interface ExecutionFilters {
  page: number
  size: number
  source?: string
  status?: string
  module?: string
  date_from?: string
  date_to?: string
  search?: string
}

export interface AuditFilters {
  page: number
  size: number
  ticket_id?: string
  event_type?: string
  stage_name?: string
  date_from?: string
  date_to?: string
}

export interface ReprocessResult {
  status: string
  execution_id: string | null
  message: string
}

// ── Beat Schedule types ──────────────────────────────────────────────────────

export type ScheduleType = 'interval' | 'crontab'

export interface BeatSchedule {
  id: number
  task_key: string
  task_name: string
  display_name: string
  description: string | null
  schedule_type: ScheduleType
  interval_seconds: number | null
  cron_expression: string | null
  enabled: boolean
  last_triggered_at: string | null
  updated_at: string
  updated_by: string | null
}

export interface ScheduleUpdate {
  enabled?: boolean
  interval_seconds?: number
  cron_expression?: string
}

export interface TriggerResult {
  status: string
  task_key: string
  message: string
}

// ── Action Registry types ─────────────────────────────────────────────────────

export interface ActionCodeEntry {
  id: number
  action_key: string
  action_code_id: string
  action_name: string
  action_description: string | null
  freshdesk_status: number | null
  freshdesk_status_name: string | null
  requires_refund: boolean
  requires_escalation: boolean
  automation_eligible: boolean
  created_at: string
}

export interface ActionCodePayload {
  action_key: string
  action_code_id: string
  action_name: string
  action_description?: string | null
  freshdesk_status?: number | null
  freshdesk_status_name?: string | null
  requires_refund?: boolean
  requires_escalation?: boolean
  automation_eligible?: boolean
}

// ── Response Template types ───────────────────────────────────────────────────

export interface ResponseTemplate {
  id: number
  template_ref: string
  action_code_id: string | null
  issue_l1: string | null
  issue_l2: string | null
  template_v1: string | null
  template_v2: string | null
  template_v3: string | null
  template_v4: string | null
  template_v5: string | null
  created_at: string
  updated_at: string
}

export interface TemplatePayload {
  template_ref: string
  action_code_id?: string | null
  issue_l1?: string | null
  issue_l2?: string | null
  template_v1?: string | null
  template_v2?: string | null
  template_v3?: string | null
  template_v4?: string | null
  template_v5?: string | null
}
