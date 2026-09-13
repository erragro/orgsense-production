import { governanceClient } from '../clients'
import type { ShadowStats, PolicyShadowEnablePayload } from '@/types/policy.types'

export const shadowApi = {
  enable: (payload: PolicyShadowEnablePayload) =>
    governanceClient.post('/shadow/enable', payload),

  disable: () =>
    governanceClient.post('/shadow/disable'),

  getStats: () =>
    governanceClient.get<ShadowStats>('/shadow/stats'),

  getResults: (page = 1, limit = 50) =>
    governanceClient.get('/shadow/results', { params: { page, limit } }),
}
