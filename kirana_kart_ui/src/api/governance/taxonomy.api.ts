import { governanceClient } from '../clients'
import type {
  TaxonomyIssue,
  TaxonomyDraft,
  TaxonomyVersion,
  TaxonomyActiveVersion,
  TaxonomyAuditEntry,
  AddIssuePayload,
  UpdateIssuePayload,
  VectorStatus,
} from '@/types/taxonomy.types'

export const taxonomyApi = {
  getAll: (include_inactive = false) =>
    governanceClient.get<TaxonomyIssue[]>('/taxonomy/', { params: { include_inactive } }),

  getDrafts: () =>
    governanceClient.get<TaxonomyDraft[]>('/taxonomy/drafts'),

  getVersions: () =>
    governanceClient.get<TaxonomyVersion[]>('/taxonomy/versions'),

  getVersion: (version_label: string) =>
    governanceClient.get<TaxonomyVersion>(`/taxonomy/version/${version_label}`),

  getDiff: (from_version: string, to_version: string) =>
    governanceClient.get('/taxonomy/diff', { params: { from_version, to_version } }),

  getActiveVersion: () =>
    governanceClient.get<TaxonomyActiveVersion>('/taxonomy/active-version'),

  validate: () =>
    governanceClient.get('/taxonomy/validate'),

  getAudit: (limit = 100) =>
    governanceClient.get<TaxonomyAuditEntry[]>('/taxonomy/audit', { params: { limit } }),

  saveDraft: (payload: AddIssuePayload) =>
    governanceClient.post('/taxonomy/draft/save', payload),

  add: (payload: AddIssuePayload) =>
    governanceClient.post<TaxonomyIssue>('/taxonomy/add', payload),

  update: (payload: UpdateIssuePayload) =>
    governanceClient.put('/taxonomy/update', payload),

  deactivate: (issue_code: string) =>
    governanceClient.patch('/taxonomy/deactivate', { issue_code }),

  reactivate: (issue_code: string) =>
    governanceClient.patch('/taxonomy/reactivate', { issue_code }),

  publish: (version_label: string) =>
    governanceClient.post('/taxonomy/publish', { version_label }),

  rollback: (version_label: string) =>
    governanceClient.post('/taxonomy/rollback', { version_label }),

  vectorizeActive: () =>
    governanceClient.post('/taxonomy/vectorize-active'),

  vectorizeVersion: (version_label: string) =>
    governanceClient.post('/taxonomy/vectorize-version', { version_label }),

  vectorStatus: () =>
    governanceClient.get<VectorStatus>('/taxonomy/vector-status'),
}
