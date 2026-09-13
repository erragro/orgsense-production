/**
 * Rule Editor API client
 * Covers: CRUD on rule_registry per KB, action codes dropdown, validation
 */

import { governanceClient as apiClient } from '../clients'

// ============================================================
// TYPES
// ============================================================

export interface Rule {
  id: number
  rule_id: string
  policy_version: string
  module_name: string
  rule_type: string
  priority: number
  rule_scope: string
  issue_type_l1: string
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

export interface ActionCode {
  id: number
  action_code_id: string
  action_name: string
  action_category: string
  requires_approval: boolean
  is_reversible: boolean
  severity_level: string | null
}

export interface RuleCreate {
  policy_version: string
  rule_id?: string
  module_name?: string
  rule_type?: string
  priority?: number
  rule_scope?: string
  issue_type_l1: string
  issue_type_l2?: string | null
  business_line?: string | null
  customer_segment?: string | null
  fraud_segment?: string | null
  min_order_value?: number | null
  max_order_value?: number | null
  min_repeat_count?: number | null
  max_repeat_count?: number | null
  sla_breach_required?: boolean
  evidence_required?: boolean
  conditions?: Record<string, unknown>
  action_id: number
  action_payload?: Record<string, unknown>
  deterministic?: boolean
  overrideable?: boolean
}

export type RuleUpdate = Partial<Omit<RuleCreate, 'policy_version'>>

export interface ValidationResult {
  warnings: Array<{ rule_id: string; message: string }>
  conflicts: Array<{ rule_ids: string[]; message: string }>
  duplicates: Array<{ rule_ids: string[]; score: number }>
  model_status: string
}

export interface CsvImportResult {
  imported: number
  skipped: number
  errors: Array<{ row: number; error: string }>
  version_label: string
}

// ============================================================
// API
// ============================================================

export const ruleApi = {
  listRules: (kbId: string, version: string) =>
    apiClient.get<Rule[]>(`/rules/${kbId}`, { params: { version } }),

  createRule: (kbId: string, data: RuleCreate) =>
    apiClient.post<{ id: number; rule_id: string }>(`/rules/${kbId}`, data),

  updateRule: (kbId: string, ruleDbId: number, data: RuleUpdate) =>
    apiClient.put<{ id: number; rule_id: string }>(`/rules/${kbId}/${ruleDbId}`, data),

  deleteRule: (kbId: string, ruleDbId: number) =>
    apiClient.delete(`/rules/${kbId}/${ruleDbId}`),

  listActionCodes: (kbId: string) =>
    apiClient.get<ActionCode[]>(`/rules/${kbId}/action-codes`),

  validateRules: (kbId: string, version: string) =>
    apiClient.get<ValidationResult>(`/rules/${kbId}/validate`, { params: { version } }),

  importCsv: (kbId: string, file: File, versionLabel: string) => {
    const form = new FormData()
    form.append('file', file)
    form.append('version_label', versionLabel)
    return apiClient.post<CsvImportResult>(`/rules/${kbId}/import-csv`, form)
  },
}
