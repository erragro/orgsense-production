import { governanceClient } from '../clients'
import type {
  QueueListResponse,
  QueueItemDetail,
  Customer360,
  NoteRow,
  ActionRow,
  TagRow,
  CannedResponse,
  NotifListResponse,
  AgentSummary,
  AgentDashboardData,
  AdminDashboardData,
  SavedView,
  ActionRequest,
  QueueFilters,
  Group,
  AutomationRule,
  SLAPolicy,
  GroupIntegration,
} from '@/types/crm.types'

export const crmApi = {
  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------
  getQueue: (params: QueueFilters) =>
    governanceClient.get<QueueListResponse>('/crm/queue', { params }),

  getQueueItem: (id: number) =>
    governanceClient.get<QueueItemDetail>(`/crm/queue/${id}`),

  getCustomer360: (id: number) =>
    governanceClient.get<Customer360>(`/crm/queue/${id}/customer360`),

  setViewing: (id: number, action: 'acquire' | 'release') =>
    governanceClient.patch(`/crm/queue/${id}/viewing`, { action }),

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------
  assignTicket: (id: number, assigneeId: number) =>
    governanceClient.post(`/crm/queue/${id}/assign`, { assignee_id: assigneeId }),

  selfAssign: (id: number) =>
    governanceClient.post(`/crm/queue/${id}/self-assign`),

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  takeAction: (id: number, body: ActionRequest) =>
    governanceClient.post<QueueItemDetail>(`/crm/queue/${id}/action`, body),

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------
  getNotes: (id: number) =>
    governanceClient.get<NoteRow[]>(`/crm/queue/${id}/notes`),

  addNote: (id: number, body: string, noteType: string = 'INTERNAL') =>
    governanceClient.post<NoteRow>(`/crm/queue/${id}/notes`, { body, note_type: noteType }),

  updateNote: (queueId: number, noteId: number, updates: { body?: string; is_pinned?: boolean }) =>
    governanceClient.patch<NoteRow>(`/crm/queue/${queueId}/notes/${noteId}`, updates),

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------
  getActions: (id: number) =>
    governanceClient.get<ActionRow[]>(`/crm/queue/${id}/actions`),

  // -------------------------------------------------------------------------
  // Tags & Watchers
  // -------------------------------------------------------------------------
  manageTags: (id: number, add: number[], remove: number[]) =>
    governanceClient.post(`/crm/queue/${id}/tags`, { add, remove }),

  manageWatchers: (id: number, add: number[], remove: number[]) =>
    governanceClient.post(`/crm/queue/${id}/watchers`, { add, remove }),

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------
  mergeTickets: (id: number, targetQueueId: number, reason?: string) =>
    governanceClient.post(`/crm/queue/${id}/merge`, { target_queue_id: targetQueueId, reason }),

  // -------------------------------------------------------------------------
  // Bulk
  // -------------------------------------------------------------------------
  bulkAssign: (queueIds: number[], assigneeId: number) =>
    governanceClient.post('/crm/queue/bulk-assign', { queue_ids: queueIds, assignee_id: assigneeId }),

  bulkEscalate: (queueIds: number[], reason: string) =>
    governanceClient.post('/crm/queue/bulk-escalate', { queue_ids: queueIds, reason }),

  bulkClose: (queueIds: number[], reason: string) =>
    governanceClient.post('/crm/queue/bulk-close', { queue_ids: queueIds, reason }),

  bulkStatus: (queueIds: number[], newStatus: string) =>
    governanceClient.post('/crm/queue/bulk-status', { queue_ids: queueIds, new_status: newStatus }),

  // -------------------------------------------------------------------------
  // Canned responses
  // -------------------------------------------------------------------------
  getCannedResponses: (params: { action_code_id?: string; issue_l1?: string }) =>
    governanceClient.get<CannedResponse[]>('/crm/canned-responses', { params }),

  // -------------------------------------------------------------------------
  // Tags library
  // -------------------------------------------------------------------------
  getTags: () =>
    governanceClient.get<TagRow[]>('/crm/tags'),

  createTag: (name: string, color: string) =>
    governanceClient.post<TagRow>('/crm/tags', { name, color }),

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------
  getNotifications: (params: { unread_only?: boolean; page?: number; limit?: number }) =>
    governanceClient.get<NotifListResponse>('/crm/notifications', { params }),

  markRead: (notificationIds: number[]) =>
    governanceClient.post('/crm/notifications/read', { notification_ids: notificationIds }),

  markAllRead: () =>
    governanceClient.post('/crm/notifications/read-all'),

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------
  getAgents: () =>
    governanceClient.get<AgentSummary[]>('/crm/agents'),

  updateAvailability: (availability: string) =>
    governanceClient.patch('/crm/agents/availability', { availability }),

  // -------------------------------------------------------------------------
  // Saved views
  // -------------------------------------------------------------------------
  getSavedViews: () =>
    governanceClient.get<SavedView[]>('/crm/saved-views'),

  saveView: (body: {
    name: string
    filters: Record<string, unknown>
    sort_by?: string
    sort_dir?: string
    is_default?: boolean
  }) => governanceClient.post<SavedView>('/crm/saved-views', body),

  deleteView: (id: number) =>
    governanceClient.delete(`/crm/saved-views/${id}`),

  // -------------------------------------------------------------------------
  // Dashboards & Reports
  // -------------------------------------------------------------------------
  getAgentDashboard: (params: { date_from: string; date_to: string }) =>
    governanceClient.get<AgentDashboardData>('/crm/dashboard/agent', { params }),

  getAdminDashboard: (params: { date_from: string; date_to: string }) =>
    governanceClient.get<AdminDashboardData>('/crm/dashboard/admin', { params }),

  getReport: (params: {
    report_type: string
    date_from: string
    date_to: string
    queue_type?: string
    agent_id?: number
  }) => governanceClient.get<Record<string, unknown>[]>('/crm/reports', { params }),

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------
  groups: {
    list: (params?: { include_inactive?: boolean }) =>
      governanceClient.get<Group[]>('/crm/groups', { params }),
    get: (id: number) =>
      governanceClient.get<Group>(`/crm/groups/${id}`),
    create: (body: { name: string; description?: string; group_type: string; routing_strategy: string }) =>
      governanceClient.post<Group>('/crm/groups', body),
    update: (id: number, body: { name?: string; description?: string; routing_strategy?: string; is_active?: boolean }) =>
      governanceClient.patch<Group>(`/crm/groups/${id}`, body),
    addMember: (groupId: number, body: { user_id: number; role?: string }) =>
      governanceClient.post(`/crm/groups/${groupId}/members`, body),
    removeMember: (groupId: number, userId: number) =>
      governanceClient.delete(`/crm/groups/${groupId}/members/${userId}`),
    assignTicket: (queueId: number, groupId: number) =>
      governanceClient.post(`/crm/queue/${queueId}/assign-group`, { group_id: groupId }),
    getIntegrations: (groupId: number) =>
      governanceClient.get<GroupIntegration[]>(`/crm/groups/${groupId}/integrations`),
    createIntegration: (groupId: number, body: { type: string; name: string; config?: Record<string, unknown> }) =>
      governanceClient.post<GroupIntegration>(`/crm/groups/${groupId}/integrations`, body),
    updateIntegration: (groupId: number, integrationId: number, body: Partial<GroupIntegration>) =>
      governanceClient.patch<GroupIntegration>(`/crm/groups/${groupId}/integrations/${integrationId}`, body),
    deleteIntegration: (groupId: number, integrationId: number) =>
      governanceClient.delete(`/crm/groups/${groupId}/integrations/${integrationId}`),
    generateApiKey: (groupId: number, body: { name: string }) =>
      governanceClient.post<GroupIntegration>(`/crm/groups/${groupId}/integrations/generate-key`, body),
    regenerateApiKey: (groupId: number, integrationId: number) =>
      governanceClient.post<GroupIntegration>(`/crm/groups/${groupId}/integrations/${integrationId}/regenerate-key`),
  },

  // -------------------------------------------------------------------------
  // Automation Rules
  // -------------------------------------------------------------------------
  automationRules: {
    list: () =>
      governanceClient.get<AutomationRule[]>('/crm/automation-rules'),
    schema: () =>
      governanceClient.get('/crm/automation-rules/schema'),
    create: (body: {
      name: string; description?: string; trigger_event: string;
      condition_logic?: string; conditions: any[]; actions: any[]; priority?: number
    }) => governanceClient.post<AutomationRule>('/crm/automation-rules', body),
    update: (id: number, body: Partial<{
      name: string; description: string; trigger_event: string;
      condition_logic: string; conditions: any[]; actions: any[];
      priority: number; is_active: boolean
    }>) => governanceClient.patch(`/crm/automation-rules/${id}`, body),
    delete: (id: number) =>
      governanceClient.delete(`/crm/automation-rules/${id}`),
    toggle: (id: number) =>
      governanceClient.post<{ is_active: boolean }>(`/crm/automation-rules/${id}/toggle`),
    preview: (body: { conditions: any[]; condition_logic?: string; trigger_event?: string }) =>
      governanceClient.post('/crm/automation-rules/preview', body),
  },

  // -------------------------------------------------------------------------
  // SLA Policies
  // -------------------------------------------------------------------------
  slaPolicies: {
    list: () =>
      governanceClient.get<SLAPolicy[]>('/crm/sla-policies'),
    update: (queueType: string, body: { resolution_minutes?: number; first_response_minutes?: number }) =>
      governanceClient.patch<SLAPolicy>(`/crm/sla-policies/${queueType}`, body),
  },

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------
  seedTestTickets: () =>
    governanceClient.post<{ created: number; skipped: number; tickets: unknown[] }>('/crm/admin/seed-test-tickets'),
}

// -------------------------------------------------------------------------
// SLA urgency helper (client-side computation)
// -------------------------------------------------------------------------
export function computeSLAUrgency(slaDueAt: string, slaBreached: boolean): {
  urgency: 'green' | 'amber' | 'red'
  minutesRemaining: number
} {
  const now = Date.now()
  const due = new Date(slaDueAt).getTime()
  const diffMs = due - now
  const minutesRemaining = Math.round(diffMs / 60000)

  if (slaBreached || diffMs <= 0) {
    return { urgency: 'red', minutesRemaining }
  }

  // Total SLA duration not easily known here, so use absolute thresholds:
  // red: < 30min, amber: < 90min, green: >= 90min
  if (minutesRemaining < 30) return { urgency: 'red', minutesRemaining }
  if (minutesRemaining < 90) return { urgency: 'amber', minutesRemaining }
  return { urgency: 'green', minutesRemaining }
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return 'Overdue'
  const h = Math.floor(Math.abs(minutes) / 60)
  const m = Math.abs(minutes) % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
