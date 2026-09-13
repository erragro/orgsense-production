import { governanceClient } from '../clients'
import type { VectorJob } from '@/types/kb.types'

export const vectorizationApi = {
  runPending: () =>
    governanceClient.post('/vectorize/run'),

  vectorizeVersion: (version_label: string) =>
    governanceClient.post('/vectorize/version', { version_label }),

  getStatus: (version_label: string) =>
    governanceClient.get<VectorJob>(`/vectorize/status/${version_label}`),

  health: () =>
    governanceClient.get('/vectorize/health'),
}
