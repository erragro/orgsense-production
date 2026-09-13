import { governanceClient } from '../clients'
import type { SystemStatus, WorkerHealth, VectorJobEntry, ModelRegistryEntry, AuditLogEntry } from '@/types/system.types'

export const governanceSystemApi = {
  health: () =>
    governanceClient.get<{ status: string }>('/health'),

  workerHealth: () =>
    governanceClient.get<WorkerHealth>('/health/worker'),

  systemStatus: () =>
    governanceClient.get<SystemStatus>('/system-status'),

  metrics: () =>
    governanceClient.get('/metrics'),

  getAdminUsers: () =>
    governanceClient.get('/admin/users'),

  createAdminUser: (payload: { api_token: string; role: string }) =>
    governanceClient.post('/admin/users', payload),

  deleteAdminUser: (id: number) =>
    governanceClient.delete(`/admin/users/${id}`),

  getVectorJobs: () =>
    governanceClient.get<VectorJobEntry[]>('/system/vector-jobs'),

  getAuditLogs: (params?: { limit?: number; offset?: number }) =>
    governanceClient.get<AuditLogEntry[]>('/system/audit-logs', { params }),

  getModelRegistry: () =>
    governanceClient.get<ModelRegistryEntry[]>('/system/models'),
}
