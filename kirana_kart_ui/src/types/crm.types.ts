// CRM system types — mirrors the backend Pydantic models and DB schema

export type QueueStatus = 'OPEN' | 'IN_PROGRESS' | 'PENDING_CUSTOMER' | 'ESCALATED' | 'RESOLVED' | 'CLOSED'
export type QueueType = 'STANDARD_REVIEW' | 'SENIOR_REVIEW' | 'SLA_BREACH_REVIEW' | 'ESCALATION_QUEUE' | 'MANUAL_REVIEW'
export type TicketType = 'INCIDENT' | 'SERVICE_REQUEST' | 'QUESTION' | 'PROBLEM'
export type NoteType = 'INTERNAL' | 'CUSTOMER_REPLY' | 'ESCALATION' | 'SYSTEM'
export type NotificationType =
  | 'ASSIGNED' | 'UNASSIGNED' | 'SLA_WARNING' | 'SLA_BREACHED'
  | 'FIRST_RESPONSE_BREACH' | 'NOTE_ADDED' | 'REPLY_SENT'
  | 'STATUS_CHANGED' | 'ESCALATED' | 'MENTIONED'
  | 'WATCHER_UPDATE' | 'MERGE' | 'BULK_ACTION'
export type Availability = 'ONLINE' | 'BUSY' | 'AWAY' | 'OFFLINE'
export type SLAUrgency = 'green' | 'amber' | 'red'

// Queue list-view row
export interface QueueItem {
  id: number
  ticket_id: number
  automation_pathway: string
  queue_type: QueueType
  status: QueueStatus
  priority: 1 | 2 | 3 | 4
  ticket_type: TicketType
  subject: string | null
  assigned_to: number | null
  assigned_to_name: string | null
  assigned_to_avatar: string | null
  assigned_at: string | null
  sla_due_at: string
  sla_breached: boolean
  first_response_due_at: string
  first_response_at: string | null
  first_response_breached: boolean
  ai_action_code: string | null
  ai_refund_amount: number | null
  ai_fraud_segment: string | null
  final_action_code: string | null
  final_refund_amount: number | null
  customer_id: string | null
  order_id: string | null
  cx_email: string | null
  customer_segment: string | null
  viewing_agent_name: string | null
  tags: TagRow[]
  watching: boolean
  created_at: string
  updated_at: string
  // Computed client-side
  sla_urgency?: SLAUrgency
  sla_minutes_remaining?: number
}

// Full work view detail
export interface QueueItemDetail extends QueueItem {
  ticket: Record<string, unknown>
  llm_output_1: Record<string, unknown> | null
  llm_output_2: Record<string, unknown> | null
  llm_output_3: Record<string, unknown> | null
  customer: Record<string, unknown>
  notes: NoteRow[]
  actions: ActionRow[]
  watchers: WatcherRow[]
  ai_reasoning: string | null
  ai_discrepancy_details: string | null
  ai_confidence: number | null
  resolution_note: string | null
  resolved_by: number | null
  resolved_at: string | null
  merged_into: number | null
  escalated_from: number | null
  escalation_reason: string | null
}

export interface NoteRow {
  id: number
  ticket_id: number
  queue_id: number | null
  author_id: number
  author_name: string
  author_avatar: string | null
  note_type: NoteType
  body: string
  is_pinned: boolean
  created_at: string
  updated_at: string
}

export interface ActionRow {
  id: number
  ticket_id: number
  queue_id: number | null
  actor_id: number
  actor_name: string
  action_type: string
  before_value: unknown
  after_value: unknown
  reason: string | null
  refund_amount_before: number | null
  refund_amount_after: number | null
  created_at: string
}

export interface WatcherRow {
  user_id: number
  full_name: string
  avatar_url: string | null
}

export interface TagRow {
  id: number
  name: string
  color: string
}

export interface CannedResponse {
  template_ref: string
  action_code_id: string | null
  issue_l1: string | null
  template_v1: string | null
  template_v2: string | null
  template_v3: string | null
  template_v4: string | null
  template_v5: string | null
}

export interface CRMNotification {
  id: number
  ticket_id: number | null
  queue_id: number | null
  type: NotificationType
  title: string
  body: string | null
  is_read: boolean
  read_at: string | null
  created_at: string
}

export interface Customer360 {
  customer_id: string
  email: string | null
  segment: string
  lifetime_order_count: number
  customer: Record<string, unknown>
  recent_tickets: Array<{
    ticket_id: number
    queue_id: number | null
    subject: string | null
    status: string | null
    created_at: string
  }>
  recent_refunds: Array<{
    refund_id: string
    refund_amount: number
    applied_action_code: string | null
    created_at: string
  }>
  csat_average: number | null
  csat_count: number
}

export interface AgentSummary {
  id: number
  full_name: string
  email: string
  avatar_url: string | null
  crm_availability: Availability
  open_tickets: number
}

export interface AgentDashboardData {
  my_queue: Partial<Record<QueueStatus, number>>
  tickets_handled: number
  avg_resolution_time_minutes: number
  avg_first_response_time_minutes: number
  csat_average: number | null
  approval_rate: number | null
  recent_actions: ActionRow[]
}

export interface AgentPerfRow {
  agent_id: number
  agent_name: string
  tickets_handled: number
  avg_resolution_time_minutes: number
  avg_first_response_time_minutes: number
  csat_average: number | null
  approval_rate: number | null
  open_count: number
}

export interface AdminDashboardData {
  queue_health: Array<{ queue_type: QueueType; status: QueueStatus; count: number }>
  sla_compliance: Array<{ queue_type: QueueType; compliance_pct: number; total: number }>
  first_response_compliance: Array<{ queue_type: QueueType; compliance_pct: number }>
  volume_trend: Array<{ date: string; count: number }>
  agent_performance: AgentPerfRow[]
  aging_buckets: Array<{ bucket: string; count: number }>
  auto_vs_hitl: { hitl: number; manual: number }
}

export interface SavedView {
  id: number
  name: string
  is_default: boolean
  filters: Record<string, unknown>
  sort_by: string
  sort_dir: string
}

export interface QueueListResponse {
  items: QueueItem[]
  total: number
  page: number
  limit: number
  pages: number
}

export interface NotifListResponse {
  items: CRMNotification[]
  total: number
  unread_count: number
  page: number
  limit: number
}

export interface ActionRequest {
  action_type: string
  final_action_code?: string
  final_refund_amount?: number
  reason?: string
  reply_body?: string
  new_priority?: number
  new_status?: QueueStatus
  new_queue_type?: QueueType
  new_ticket_type?: TicketType
}

// Queue filter params used by the queue page
export interface QueueFilters {
  queue_type?: QueueType | ''
  status?: QueueStatus | ''
  assigned_to?: number | null
  priority?: number | null
  sla_breached?: boolean | null
  search?: string
  tags?: string
  sort_by?: string
  sort_dir?: 'asc' | 'desc'
  page?: number
  limit?: number
}

// Priority labels
export const PRIORITY_LABELS: Record<number, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Normal',
  4: 'Low',
}

export const PRIORITY_COLORS: Record<number, string> = {
  1: 'text-red-600 bg-red-50',
  2: 'text-orange-600 bg-orange-50',
  3: 'text-blue-600 bg-blue-50',
  4: 'text-gray-600 bg-gray-50',
}

export const QUEUE_TYPE_LABELS: Record<QueueType, string> = {
  STANDARD_REVIEW: 'Standard Review',
  SENIOR_REVIEW: 'Senior Review',
  SLA_BREACH_REVIEW: 'SLA Breach',
  ESCALATION_QUEUE: 'Escalation',
  MANUAL_REVIEW: 'Manual Review',
}

export const STATUS_LABELS: Record<QueueStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  PENDING_CUSTOMER: 'Pending Customer',
  ESCALATED: 'Escalated',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
}

export const STATUS_COLORS: Record<QueueStatus, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  IN_PROGRESS: 'bg-yellow-100 text-yellow-700',
  PENDING_CUSTOMER: 'bg-purple-100 text-purple-700',
  ESCALATED: 'bg-red-100 text-red-700',
  RESOLVED: 'bg-green-100 text-green-700',
  CLOSED: 'bg-gray-100 text-gray-500',
}

export const ACTION_TYPE_LABELS: Record<string, string> = {
  APPROVE_AI_REC: 'Approved AI Recommendation',
  REJECT_AI_REC: 'Rejected AI Recommendation',
  MODIFY_REFUND: 'Modified Refund Amount',
  ESCALATE: 'Escalated Ticket',
  SELF_ASSIGN: 'Self-Assigned',
  REASSIGN: 'Reassigned',
  ADD_NOTE: 'Added Note',
  REPLY_CUSTOMER: 'Replied to Customer',
  RESOLVE: 'Resolved Ticket',
  REOPEN: 'Reopened Ticket',
  CLOSE: 'Closed Ticket',
  CHANGE_PRIORITY: 'Changed Priority',
  CHANGE_STATUS: 'Changed Status',
  CHANGE_TYPE: 'Changed Ticket Type',
  CHANGE_QUEUE: 'Changed Queue',
  ADD_TAG: 'Added Tag',
  REMOVE_TAG: 'Removed Tag',
  ADD_WATCHER: 'Added Watcher',
  REMOVE_WATCHER: 'Removed Watcher',
  MERGE: 'Merged Ticket',
  BULK_ASSIGN: 'Bulk Assigned',
  BULK_ESCALATE: 'Bulk Escalated',
  BULK_CLOSE: 'Bulk Closed',
  BULK_STATUS: 'Bulk Status Change',
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type GroupType = 'SUPPORT' | 'FRAUD_REVIEW' | 'ESCALATION' | 'SENIOR_REVIEW' | 'CUSTOM'
export type RoutingStrategy = 'ROUND_ROBIN' | 'LEAST_BUSY' | 'MANUAL'
export type MemberRole = 'AGENT' | 'LEAD' | 'MANAGER'

export interface GroupMember {
  user_id: number
  role: MemberRole
  added_at: string
  email: string
  full_name: string | null
  crm_availability: string
}

export interface Group {
  id: number
  name: string
  description: string | null
  group_type: GroupType
  routing_strategy: RoutingStrategy
  is_active: boolean
  created_at: string
  member_count: number
  members?: GroupMember[]
}

// ---------------------------------------------------------------------------
// Automation Rules
// ---------------------------------------------------------------------------

export interface RuleCondition {
  field: string
  operator: string
  value: string
}

export interface RuleAction {
  action_type: string
  params: Record<string, any>
}

export interface AutomationRule {
  id: number
  name: string
  description: string | null
  trigger_event: 'TICKET_CREATED' | 'TICKET_UPDATED' | 'SLA_WARNING' | 'SLA_BREACHED' | 'TIME_BASED'
  condition_logic: 'AND' | 'OR'
  conditions: RuleCondition[]
  actions: RuleAction[]
  is_active: boolean
  priority: number
  run_count: number
  last_run_at: string | null
  is_seeded: boolean
  created_by_name: string | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// SLA Policies
// ---------------------------------------------------------------------------

export interface SLAPolicy {
  id: number
  queue_type: string
  resolution_minutes: number
  first_response_minutes: number
  is_active: boolean
  updated_at: string | null
  updated_by_name: string | null
}

// -------------------------------------------------------------------------
// Group Integrations
// -------------------------------------------------------------------------

export type IntegrationType = 'SMTP_INBOUND' | 'API_KEY' | 'WEBHOOK' | 'CARDINAL_RULE'

export interface GroupIntegration {
  id: number
  group_id: number
  type: IntegrationType
  name: string
  config: Record<string, unknown>
  is_active: boolean
  api_key_masked: string | null
  api_key_full?: string  // Only returned on creation/regeneration
  created_at: string
  updated_at: string
}
