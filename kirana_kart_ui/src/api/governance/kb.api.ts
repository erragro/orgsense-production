import { governanceClient } from '../clients'
import type { KBRawUpload, KBVersion, KBActiveVersion, KBUploadPayload, RuleEntry } from '@/types/kb.types'

export const kbApi = {
  upload: (payload: KBUploadPayload) =>
    governanceClient.post('/kb/upload', payload),

  update: (raw_id: number, payload: { new_raw_content: string; original_format: string }) =>
    governanceClient.put(`/kb/update/${raw_id}`, payload),

  publish: (version_label: string, published_by: string) =>
    governanceClient.post('/kb/publish', { version_label, published_by }),

  rollback: (version_label: string) =>
    governanceClient.post(`/kb/rollback/${version_label}`),

  getRaw: (raw_id: number) =>
    governanceClient.get<KBRawUpload>(`/kb/raw/${raw_id}`),

  getActiveDraft: (document_id: string) =>
    governanceClient.get(`/kb/active/${document_id}`),

  getActiveVersion: () =>
    governanceClient.get<KBActiveVersion>('/kb/active-version'),

  getVersion: (version: string) =>
    governanceClient.get<KBVersion>(`/kb/version/${version}`),

  getVersions: () =>
    governanceClient.get<KBVersion[]>('/kb/versions'),

  getUploads: () =>
    governanceClient.get<KBRawUpload[]>('/kb/uploads'),

  getRules: (version_label: string) =>
    governanceClient.get<RuleEntry[]>(`/kb/rule-registry/${version_label}`),
}
