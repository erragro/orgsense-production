/**
 * BPM Policy Lifecycle API client.
 * Covers: KB management, process instances, stage transitions, approvals.
 */

import { governanceClient as apiClient } from '../clients'

// A long SOP is read in up to 8 sequential model calls (nginx allows 600 s).
const ANALYSIS_TIMEOUT_MS = 600_000

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
  /** Set when a person made the decision (bulk acceptance included). */
  edited_by?: number | null
  /** The SOP text the AI based this on. */
  source_excerpt?: string | null
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
  edited_by?: number | null
  source_excerpt?: string | null
}

export interface ReviewProposalPayload {
  status: ProposalStatus
  edit_reason?: string
  user_output?: Record<string, unknown>
}

export interface AnalysisResult<T> {
  proposals: T[]
  count: number
  /** Problems the SOP describes that the live taxonomy has no code for. */
  gaps?: TaxonomyGap[] | null
  /** Tenant values the SOP states (knowledge extraction only). */
  suggested_variables?: Array<{ name: string; value: string; defined: boolean }> | null
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
    knowledge_pending?: number
    knowledge_accepted?: number
    gaps_open?: number
  }
  /** Runtime preparation (vectorization) of the submitted rules. */
  preparation_status: 'pending' | 'in_progress' | 'completed' | 'failed' | null
  rules_unchanged_since_submission: boolean
  pending_approval: { id: number; requested_by_id: number | null; requested_by: string | null; requested_at: string } | null
  live_version: string | null
  live_comparison_version: string | null
  live_comparison_cases: number
  business_line?: string | null
  /** {{variables}} passages use that have no value yet. */
  undefined_variables?: string[]
}

// ── Closed taxonomy, knowledge passages, variables, lessons ────────────────

export interface LiveIssue {
  issue_code: string
  label: string
  description: string | null
  level: number
  parent_code: string | null
}

export interface TaxonomyGap {
  id: number
  entity_id?: string
  business_line: string | null
  label: string
  description: string | null
  suggested_code: string | null
  suggested_parent_code: string | null
  source_excerpt: string | null
  extraction_confidence: number | null
  status: 'open' | 'mapped' | 'dismissed'
  mapped_issue_code: string | null
  resolution_note: string | null
}

export type ChunkPurpose = 'decision' | 'response' | 'both'

export interface KnowledgeChunk {
  id: number
  chunk_key: string
  business_line: string | null
  title: string
  body: string
  issue_codes: string[]
  purpose: ChunkPurpose
  source_excerpt: string | null
  source_start: number | null
  source_end: number | null
  origin: 'ai' | 'human'
  status: ProposalStatus
  llm_output: Record<string, unknown> | null
  edit_reason: string | null
  variables: string[]
  undefined_variables: string[]
}

export interface KnowledgeListing {
  business_line: string | null
  chunks: KnowledgeChunk[]
  undefined_variables: string[]
}

export interface ChunkReviewPayload {
  status: 'accepted' | 'edited' | 'rejected'
  edit_reason?: string
  title?: string
  body?: string
  issue_codes?: string[]
  purpose?: ChunkPurpose
}

export interface PolicyVariable {
  id: number
  business_line: string
  name: string
  value: string
  description: string | null
  updated_at: string
}

export interface VariablesListing {
  variables: PolicyVariable[]
  suggested: Array<{ name: string; description: string }>
  ticket_variables: Array<{ name: string; description: string }>
}

export interface Lesson {
  id: number
  stage: string
  item_ref: string | null
  edit_type: string
  edit_reason: string | null
  business_line: string | null
  same_line: boolean
  summary: string
  created_at: string
}

export interface RuleDecisionSummary {
  /** RULE_ENFORCEMENT: observe records only; enforce lets rules decide. */
  mode: 'observe' | 'enforce'
  days: number
  evaluated: number
  matched: number
  applied: number
  /** Matched tickets where the rule's decision differs from the AI's. */
  differs: number
  last_evaluated_at: string | null
  by_rule: Array<{ rule_id: string; rule_action: string | null; matched: number; differs: number }>
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

  getRuleDecisionSummary: (days = 7) =>
    apiClient.get<RuleDecisionSummary>('/bpm/rule-decisions/summary', { params: { days } }),

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

  // --- Closed taxonomy, knowledge, variables, lessons ---

  getLiveTaxonomy: (kbId: string) =>
    apiClient.get<LiveIssue[]>(`/bpm/kb/${kbId}/live-taxonomy`),

  listTaxonomyGaps: (kbId: string, params: { entity_id?: string; status?: TaxonomyGap['status'] } = {}) =>
    apiClient.get<TaxonomyGap[]>(`/bpm/kb/${kbId}/taxonomy-gaps`, { params }),

  resolveTaxonomyGap: (kbId: string, gapId: number,
                       body: { action: 'map' | 'dismiss' | 'reopen'; issue_code?: string; note?: string }) =>
    apiClient.post<{ id: number; status: TaxonomyGap['status']; mapped_issue_code: string | null }>(
      `/bpm/kb/${kbId}/taxonomy-gaps/${gapId}`, body),

  acceptAll: (kbId: string, entityId: string, kind: 'taxonomy' | 'actions' | 'knowledge', minConfidence?: number) =>
    apiClient.post<{ accepted: number }>(`/bpm/kb/${kbId}/proposals/${entityId}/accept-all`,
      { kind, ...(minConfidence != null ? { min_confidence: minConfidence } : {}) }),

  extractKnowledge: (kbId: string, entityId: string) =>
    apiClient.post<AnalysisResult<KnowledgeChunk>>(`/bpm/kb/${kbId}/extract-knowledge`,
      { entity_id: entityId }, { timeout: ANALYSIS_TIMEOUT_MS }),

  listKnowledge: (kbId: string, entityId: string) =>
    apiClient.get<KnowledgeListing>(`/bpm/kb/${kbId}/knowledge`, { params: { entity_id: entityId } }),

  addKnowledge: (kbId: string, body: { entity_id: string; title: string; body: string; issue_codes: string[];
                                        purpose: ChunkPurpose; edit_reason?: string }) =>
    apiClient.post<{ id: number; chunk_key: string }>(`/bpm/kb/${kbId}/knowledge`, body),

  reviewKnowledge: (kbId: string, chunkId: number, body: ChunkReviewPayload) =>
    apiClient.put<{ id: number; status: string }>(`/bpm/kb/${kbId}/knowledge/${chunkId}`, body),

  previewKnowledge: (kbId: string, chunkId: number) =>
    apiClient.get<{ title: string; text: string; sample_values: Record<string, string> }>(
      `/bpm/kb/${kbId}/knowledge/${chunkId}/preview`),

  listVariables: (kbId: string) =>
    apiClient.get<VariablesListing>(`/bpm/kb/${kbId}/variables`),

  setVariable: (kbId: string, body: { name: string; value: string; business_line?: string | null;
                                       description?: string; reason?: string }) =>
    apiClient.put<PolicyVariable>(`/bpm/kb/${kbId}/variables`, body),

  deleteVariable: (kbId: string, variableId: number) =>
    apiClient.delete(`/bpm/kb/${kbId}/variables/${variableId}`),

  listBusinessLines: (kbId: string) =>
    apiClient.get<{ business_lines: string[] }>(`/bpm/kb/${kbId}/business-lines`),

  setBusinessLine: (kbId: string, entityId: string, businessLine: string | null) =>
    apiClient.put<{ entity_id: string; business_line: string | null }>(
      `/bpm/kb/${kbId}/proposals/${entityId}/business-line`, { business_line: businessLine }),

  listLessons: (kbId: string, businessLine?: string | null) =>
    apiClient.get<{ business_line: string | null; lessons: Lesson[] }>(`/bpm/kb/${kbId}/lessons`,
      { params: businessLine ? { business_line: businessLine } : {} }),

  getExtractionStandards: (kbId: string) =>
    apiClient.get<{ standards_md: string; version: number; updated_at: string | null }>(`/bpm/standards/${kbId}`),
}
