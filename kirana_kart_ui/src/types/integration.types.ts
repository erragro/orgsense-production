// src/types/integration.types.ts
// ================================
// Types for the Channel Integrations module.

export type IntegrationType = 'gmail' | 'outlook' | 'smtp' | 'api'
export type SyncStatus = 'idle' | 'running' | 'ok' | 'error'

export interface Integration {
  id: number
  name: string
  type: IntegrationType
  org: string
  business_line: string
  module: string
  is_active: boolean
  /** Config is redacted on list/get endpoints — sensitive fields show "***" */
  config: Record<string, unknown>
  last_synced_at?: string | null
  sync_status: SyncStatus
  sync_error?: string | null
  created_by?: number | null
  created_at: string
  updated_at: string
}

export interface CreateIntegrationPayload {
  name: string
  type: IntegrationType
  org: string
  business_line: string
  module: string
  config: Record<string, unknown>
}

export interface UpdateIntegrationPayload {
  name?: string
  org?: string
  business_line?: string
  module?: string
  config?: Record<string, unknown>
}

export interface TestResult {
  success: boolean
  message: string
}

export interface GenerateKeyResult {
  api_key: string
}
