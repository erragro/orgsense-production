export interface TaxonomyIssue {
  id: number
  issue_code: string
  label: string
  description: string | null
  parent_id: number | null
  level: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface TaxonomyDraft {
  id: number
  issue_code: string
  label: string
  description: string | null
  parent_id: number | null
  level: number
  is_active: boolean
  updated_at: string
}

export interface TaxonomyVersion {
  version_id: number
  version_label: string
  created_by: string | null
  created_at: string
  snapshot_data: TaxonomyIssue[]
  status: string
}

export interface TaxonomyActiveVersion {
  active_version: string
}

export interface TaxonomyDiffResult {
  added: TaxonomyIssue[]
  removed: TaxonomyIssue[]
  updated: Array<{ old: TaxonomyIssue; new: TaxonomyIssue }>
}

export interface TaxonomyAuditEntry {
  id: number
  issue_id: number | null
  issue_code: string
  action_type: string
  old_data: unknown
  new_data: unknown
  changed_by: string
  change_reason: string | null
  changed_at: string
}

export interface AddIssuePayload {
  issue_code: string
  label: string
  description?: string
  parent_id?: number | null
  level: number
}

export interface UpdateIssuePayload {
  issue_code: string
  label?: string
  description?: string
}

export interface VectorStatus {
  version_label: string
  status: string
  collection_name?: string
  document_count?: number
}
