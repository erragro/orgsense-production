import { governanceClient } from '../clients'
import type { AnalyticsSummary, RefundRecord, EvaluationResponse, EvaluationFilters } from '@/types/analytics.types'

export const analyticsApi = {
  getSummary: (params: { date_from?: string; date_to?: string }) =>
    governanceClient.get<AnalyticsSummary>('/analytics/summary', { params }),

  getRefunds: (params: { page?: number; limit?: number; date_from?: string; date_to?: string }) =>
    governanceClient.get<RefundRecord[]>('/analytics/refunds', { params }),

  getPolicyrules: (params: { version?: string; module?: string }) =>
    governanceClient.get('/policy/rules', { params }),

  getEvaluationFilters: () =>
    governanceClient.get<EvaluationFilters>('/analytics/evaluation-filters'),

  getEvaluations: (params: {
    page?: number
    limit?: number
    date_from?: string
    date_to?: string
    module?: string
    issue_l1?: string
    issue_l2?: string
    fraud_segment?: string
    value_segment?: string
    action_code?: string
    automation_pathway?: string
    standard_logic_passed?: string
    greedy_classification?: string
    override_applied?: string
    pipeline_stage?: string
  }) =>
    governanceClient.get<EvaluationResponse>('/analytics/evaluations', { params }),

  getFCR: (params: { date_from?: string; date_to?: string }) =>
    governanceClient.get<{
      total_checked: number
      fcr_true: number
      fcr_false: number
      fcr_pending: number
      true_fcr_rate: number | null
      by_intent: { intent: string; total: number; fcr_true: number; fcr_false: number; true_fcr_rate: number | null }[]
      trend: { date: string; checked: number; fcr_true: number }[]
    }>('/analytics/fcr', { params }),

  getSpikes: (params?: { limit?: number }) =>
    governanceClient.get<{
      items: {
        spike_id: string
        window_start: string
        window_end: string
        current_volume: number
        baseline_mean: number
        sigma_above: number
        cluster_method: string
        clusters_json: { name: string; count: number; percentage: number; top_issue_l1: string; top_issue_l2: string }[]
        produced_at: string
      }[]
      total: number
      message?: string
    }>('/analytics/spikes', { params }),

  getAgentQuality: (params: { page?: number; limit?: number; resolved?: string }) =>
    governanceClient.get<{
      flags: { agent_id: string; flagged_at: string; total_tickets: number; refund_rate: number; manual_review_count: number; flag_reason: string; resolved: boolean }[]
      total_flags: number
      total_pages: number
      qa_summary: { agent_id: string; total_scored: number; avg_qa_score: number; avg_canned_ratio: number; avg_grammar_errors: number; flagged_count: number; last_scored_at: string }[]
      coverage: number
      total_conversations: number
      total_scored: number
    }>('/analytics/agent-quality', { params }),
}
