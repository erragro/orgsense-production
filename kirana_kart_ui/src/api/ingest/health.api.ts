import { ingestClient } from '../clients'
import type { SystemStatus } from '@/types/system.types'

export const ingestHealthApi = {
  health: () => ingestClient.get<{ status: string }>('/health'),
  systemStatus: () => ingestClient.get<SystemStatus>('/system-status'),
}
