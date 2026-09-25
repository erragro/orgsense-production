/**
 * BPM Policy Lifecycle API client.
 * Covers: KB management, process instances, stage transitions, approvals.
 */

import { governanceClient as apiClient } from '../clients'

const ANALYSIS_TIMEOUT_MS = 180_000

// ============================================================
// TYPES
// ============================================================

export type KBRole = 'view' | 'edit' | 'admin'
export type EntityType = 'kb_version' | 'taxonomy_version'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'superseded'
export type GateType = 'simulation' | 'shadow' | 'diff_review'

export interface KnowledgeBase {
  id: number
  kb_id: string
  kb_name: string
  description: string | null
  is_active: boolean
  created_at: string
  active_version: string | null
  member_count?: number
  my_role?: KBRole
}

export interface KBMember {
  id: number
  kb_id: string
  user_id: number
  role: KBRole
  granted_at: string
  email: string
  full_name: string | null
}

export interface BPMInstance {
  id: number
  kb_id: string
  process_name: string
  entity_id: string
  entity_type: EntityType
  current_stage: string
  created_by_id: number | null
  created_by_name: string | null
  started_at: string
  completed_at: string | null
  ml_predictions: Record<string, unknown>
  metadata: Record<string, unknown>
  pending_approvals?: number
}

export interface StageTransition {
  id: number
  instance_id: number
  from_stage: string
  to_stage: string
  actor_id: number | null
  actor_name: string | null
  notes: string | null
  transition_data: Record<string, unknown>
  transitioned_at: string
}

export interface BPMApproval {
  id: number
  instance_id: number
  stage: string
  status: ApprovalStatus
  requested_by_id: number | null
  requested_by: string | null
  reviewer_id: number | null
  reviewer_name: string | null
  review_notes: string | null
  requested_at: string
  reviewed_at: string | null
}

export interface GateResult {
  id: number
  instance_id: number
  gate_type: GateType
  passed: boolean
  metrics: Record<string, unknown>
  ml_prediction: Record<string, unknown> | null
  ran_at: string
}

export type MLModelStatus = 'active' | 'learning' | 'no_data'

export interface MLModelHealth {
  model_key: string
  display_name: string
  status: MLModelStatus
  accuracy: number | null
  f1_score?: number | null
  sample_count: number
  samples_needed?: number
  trained_at?: string
}

// ── SOP Extraction proposal types ──────────────────────────────────────────

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'edited'
export type ProposalType = 'new' | 'update' | 'existing'

export interface TaxonomyProposal {
  id: number
  issue_code: string
  label: string
  description: string | null
  parent_code: string | null
  level: number
  proposal_type: ProposalType
  status: ProposalStatus
  extraction_confidence: number | null
  edit_reason: string | null
  llm_output: Record<string, unknown> | null
  user_output: Record<string, unknown> | null
  edited_at: string | null
}

export interface ActionProposal {
  id: number
  action_code_id: string
  action_name: string
  action_description: string | null
  exact_action: string | null
  parent_issue_codes: string[]
  requires_refund: boolean
  requires_escalation: boolean
  automation_eligible: boolean
  proposal_type: ProposalType
  status: ProposalStatus
  extraction_confidence: number | null
  edit_reason: string | null
  llm_output: Record<string, unknown> | null
  user_output: Record<string, unknown> | null
  edited_at: string | null
}

export interface ReviewProposalPayload {
  status: ProposalStatus
  edit_reason?: string
  user_output?: Record<string, unknown>
}

export interface AnalysisResult<T> {
  proposals: T[]
  count: number
  /** The document is longer than the part the analysis read. */
  truncated: boolean
  analysed_characters: number
  document_characters: number
}

export interface SkippedPairing {
  issue_code: string
  action_code_id: string
  reason: string
}

export interface GateMetrics {
  status?: 'not_applicable'
  reason?: string
  unchanged_rate?: number
  changed_count?: number
  ticket_count?: number
  rule_count: number
  baseline_version?: string
  candidate_version: string
  threshold?: number
  sample_source?: string
  measurement_scope?: string
  examples?: Array<{ ticket_id: string | number; baseline: string; candidate: string }>
}

export interface SimulationGateResult {
  status: 'ok' | 'not_applicable' | 'unavailable'
  passed: boolean | null
  reason?: string | null
  metrics: GateMetrics | null
  examples?: Array<{ ticket_id: string | number; baseline: string; candidate: string }>
  stage?: string
}

export interface ProposalReadiness {
  stage: string
  review: {
    taxonomy_pending: number
    taxonomy_accepted: number
    actions_pending: number
    actions_accepted: number
    rules: number
  }
  /** Runtime preparation (vectorization) of the submitted rules. */
  preparation_status: 'pending' | 'in_progress' | 'completed' | 'failed' | null
  rules_unchanged_since_submission: boolean
  pending_approval: { id: number; requested_by_id: number | null; requested_by: string | null; requested_at: string } | null
  live_version: string | null
  live_comparison_version: string | null
  live_comparison_cases: number
}

export interface GeneratedRule {
  rule_id: string
  issue_type_l1: string
  issue_type_l2: string | null
  action_code_id: string
  action_name: string
  exact_action: string | null
}

// ============================================================
// KB MANAGEMENT
// ============================================================

export const bpmApi = {
  // --- Knowledge Bases ---

  listKBs: () =>
    apiClient.get<KnowledgeBase[]>('/bpm/kbs'),

  createKB: (data: { kb_id: string; kb_name: string; description?: string }) =>
    apiClient.post<KnowledgeBase>('/bpm/kbs', data),

  getKBMembers: (kbId: string) =>
    apiClient.get<KBMember[]>(`/bpm/kbs/${kbId}/members`),

  setKBMember: (kbId: string, userId: number, role: KBRole) =>
    apiClient.post(`/bpm/kbs/${kbId}/members`, { user_id: userId, role }),

  removeKBMember: (kbId: string, userId: number) =>
    apiClient.delete(`/bpm/kbs/${kbId}/members/${userId}`),

  // --- Instances ---

  listInstances: (kbId: string, params?: { stage?: string; limit?: number; entity_id?: string }) =>
    apiClient.get<BPMInstance[]>(`/bpm/${kbId}/instances`, { params }),

  createInstance: (
    kbId: string,
    data: {
      entity_id: string
      entity_type: EntityType
      process_name: string
      metadata?: Record<string, unknown>
    },
  ) => apiClient.post<BPMInstance>(`/bpm/${kbId}/instances`, data),

  getInstance: (kbId: string, instanceId: number) =>
    apiClient.get<BPMInstance>(`/bpm/${kbId}/instances/${instanceId}`),

  transition: (
    kbId: string,
    instanceId: number,
    toStage: string,
    notes?: string,
    transitionData?: Record<string, unknown>,
  ) =>
    apiClient.post<BPMInstance>(`/bpm/${kbId}/instances/${instanceId}/transition`, {
      to_stage: toStage,
      notes,
      transition_data: transitionData,
    }),

  getAuditTrail: (kbId: string, instanceId: number) =>
    apiClient.get<StageTransition[]>(`/bpm/${kbId}/instances/${instanceId}/trail`),

  getGateResults: (kbId: string, instanceId: number) =>
    apiClient.get<GateResult[]>(`/bpm/${kbId}/instances/${instanceId}/gates`),

  getPendingApprovals: (kbId: string, instanceId: number) =>
    apiClient.get<BPMApproval[]>(`/bpm/${kbId}/instances/${instanceId}/approvals`),

  // --- Policy Studio lifecycle (server advances the stage) ---

  simulate: (kbId: string, entityId: string) =>
    apiClient.post<SimulationGateResult>(`/bpm/kb/${kbId}/simulate`, { entity_id: entityId }),

  submitForApproval: (kbId: string, entityId: string, justification?: string) =>
    apiClient.post<{ approval: BPMApproval | null; stage: string }>(`/bpm/kb/${kbId}/submit`, {
      entity_id: entityId,
      justification,
    }),

  getReadiness: (kbId: string, entityId: string) =>
    apiClient.get<ProposalReadiness>(`/bpm/kb/${kbId}/proposals/${entityId}/readiness`),

  reopenForEditing: (kbId: string, instanceId: number, notes?: string) =>
    apiClient.post<BPMInstance>(`/bpm/${kbId}/instances/${instanceId}/transition`, {
      to_stage: 'RULE_EDIT',
      notes,
    }),

  // --- Approval Actions ---

  approveRequest: (approvalId: number, notes?: string) =>
    apiClient.post(`/bpm/approvals/${approvalId}/approve`, { notes }),

  rejectRequest: (approvalId: number, notes?: string) =>
    apiClient.post(`/bpm/approvals/${approvalId}/reject`, { notes }),

  // --- ML Model Health ---

  getMLHealth: (kbId = 'default') =>
    apiClient.get<MLModelHealth[]>('/bpm/ml/health', { params: { kb_id: kbId } }),

  forceRetrain: (kbId = 'default') =>
    apiClient.post('/bpm/ml/retrain', null, { params: { kb_id: kbId } }),

  // --- SOP Extraction Pipeline ---

  // LLM analysis of a long SOP can exceed the client's default 30 s.
  extractTaxonomy: (kbId: string, entityId: string) =>
    apiClient.post<AnalysisResult<TaxonomyProposal>>(`/bpm/kb/${kbId}/extract-taxonomy`,
      { entity_id: entityId }, { timeout: ANALYSIS_TIMEOUT_MS }),

  listTaxonomyProposals: (kbId: string, entityId: string) =>
    apiClient.get<TaxonomyProposal[]>(`/bpm/kb/${kbId}/taxonomy-proposals`, { params: { entity_id: entityId } }),

  reviewTaxonomyProposal: (kbId: string, proposalId: number, payload: ReviewProposalPayload) =>
    apiClient.put<TaxonomyProposal>(`/bpm/kb/${kbId}/taxonomy-proposals/${proposalId}`, payload),

  extractActions: (kbId: string, entityId: string) =>
    apiClient.post<AnalysisResult<ActionProposal>>(`/bpm/kb/${kbId}/extract-actions`,
      { entity_id: entityId }, { timeout: ANALYSIS_TIMEOUT_MS }),

  listActionProposals: (kbId: string, entityId: string) =>
    apiClient.get<ActionProposal[]>(`/bpm/kb/${kbId}/action-proposals`, { params: { entity_id: entityId } }),

  reviewActionProposal: (kbId: string, proposalId: number, payload: ReviewProposalPayload) =>
    apiClient.put<ActionProposal>(`/bpm/kb/${kbId}/action-proposals/${proposalId}`, payload),

  generateRules: (kbId: string, entityId: string) =>
    apiClient.post<{ rules: GeneratedRule[]; skipped: SkippedPairing[]; count: number; stage: string }>(
      `/bpm/kb/${kbId}/generate-rules`, { entity_id: entityId }),

  getExtractionStandards: (kbId: string) =>
    apiClient.get<{ standards_md: string; version: number; updated_at: string | null }>(`/bpm/standards/${kbId}`),
}
