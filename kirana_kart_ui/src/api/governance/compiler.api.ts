import { governanceClient } from '../clients'
import type { CompilerStatus, ActionCode, ExtractActionsResult } from '@/types/kb.types'

export const compilerApi = {
  compileLatest: () =>
    governanceClient.post('/compiler/compile-latest'),

  compileVersion: (version_label: string) =>
    governanceClient.post(`/compiler/compile-version/${version_label}`),

  getStatus: (version_label: string) =>
    governanceClient.get<CompilerStatus>(`/compiler/status/${version_label}`),

  getActionCodes: () =>
    governanceClient.get<ActionCode[]>('/compiler/action-codes'),

  extractActions: (version_label: string) =>
    governanceClient.post<ExtractActionsResult>('/compiler/extract-actions', { version_label }),
}
