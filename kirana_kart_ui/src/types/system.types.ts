export interface SystemStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  database: 'ok' | 'error'
  redis: 'ok' | 'error'
  weaviate?: 'ok' | 'error'
  active_version?: string
  shadow_version?: string | null
  timestamp?: string
}

export interface WorkerHealth {
  status: 'alive' | 'dead'
  last_heartbeat_s?: number
  jobs_processed?: number
  poll_interval?: number
}

export interface VectorJobEntry {
  id: number
  version_label: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  created_at: string
  started_at: string | null
  completed_at: string | null
  error: string | null
}

export interface ModelRegistryEntry {
  model_name: string
  model_version: string
  deployed_at: string | null
  is_active: boolean | null
}

export interface AuditLogEntry {
  id: number
  execution_id?: string | null
  ticket_id?: number | null
  stage_name?: string | null
  event_time: string
  event_type: string
  message: string
  metadata?: unknown
  // taxonomy audit fields
  issue_code?: string
  action_type?: string
  changed_by?: string
  changed_at?: string
}
