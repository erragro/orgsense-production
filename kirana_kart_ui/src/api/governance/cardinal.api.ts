// src/api/governance/cardinal.api.ts
// ====================================
// API client for the Cardinal Intelligence module.

import { governanceClient } from '@/api/clients'
import type {
  CardinalOverview,
  PhaseStats,
  ExecutionsResponse,
  ExecutionDetail,
  AuditResponse,
  ReprocessResult,
  ExecutionFilters,
  AuditFilters,
  BeatSchedule,
  ScheduleUpdate,
  TriggerResult,
  ActionCodeEntry,
  ActionCodePayload,
  ResponseTemplate,
  TemplatePayload,
} from '@/types/cardinal.types'

export const cardinalApi = {
  /** Pipeline summary stats + volume trend + distributions. */
  overview: () =>
    governanceClient.get<CardinalOverview>('/cardinal/overview'),

  /** Per-phase (Cardinal phases + LLM stages) pass/fail/latency breakdown. */
  phaseStats: () =>
    governanceClient.get<PhaseStats[]>('/cardinal/phase-stats'),

  /** Paginated list of ticket executions with optional filters. */
  executions: (filters: ExecutionFilters) =>
    governanceClient.get<ExecutionsResponse>('/cardinal/executions', {
      params: filters,
    }),

  /** Full execution trace for a single ticket (all phases + LLM outputs). */
  executionDetail: (ticketId: string) =>
    governanceClient.get<ExecutionDetail>(`/cardinal/executions/${ticketId}`),

  /** Paginated execution audit log. */
  audit: (filters: AuditFilters) =>
    governanceClient.get<AuditResponse>('/cardinal/audit', {
      params: filters,
    }),

  /** Re-submit a ticket through the Cardinal pipeline. Requires cardinal.admin. */
  reprocess: (ticketId: string) =>
    governanceClient.post<ReprocessResult>(`/cardinal/reprocess/${ticketId}`),

  /** List all Celery Beat schedule configs. */
  schedules: () =>
    governanceClient.get<BeatSchedule[]>('/cardinal/schedules'),

  /** Update a beat schedule's enabled flag or interval. Requires cardinal.admin. */
  updateSchedule: (taskKey: string, patch: ScheduleUpdate) =>
    governanceClient.patch<BeatSchedule>(`/cardinal/schedules/${taskKey}`, patch),

  /** Manually fire a beat task immediately. Requires cardinal.admin. */
  triggerSchedule: (taskKey: string) =>
    governanceClient.post<TriggerResult>(`/cardinal/schedules/${taskKey}/trigger`),

  /** Reset a schedule to default interval and re-enable it. Requires cardinal.admin. */
  resetSchedule: (taskKey: string) =>
    governanceClient.post<BeatSchedule>(`/cardinal/schedules/${taskKey}/reset`),

  // ── Action Registry ───────────────────────────────────────────────────────

  /** List all master_action_codes rows. Requires cardinal.view. */
  listActionRegistry: () =>
    governanceClient.get<ActionCodeEntry[]>('/cardinal/action-registry'),

  /** Create a new action code. Requires cardinal.admin. */
  createActionCode: (payload: ActionCodePayload) =>
    governanceClient.post<ActionCodeEntry>('/cardinal/action-registry', payload),

  /** Update an action code by id. Requires cardinal.admin. */
  updateActionCode: (id: number, payload: Partial<ActionCodePayload>) =>
    governanceClient.put<ActionCodeEntry>(`/cardinal/action-registry/${id}`, payload),

  /** Delete an action code by id. Requires cardinal.admin. */
  deleteActionCode: (id: number) =>
    governanceClient.delete(`/cardinal/action-registry/${id}`),

  // ── Templates ─────────────────────────────────────────────────────────────

  /** List all response_templates rows. Requires cardinal.view. */
  listTemplates: () =>
    governanceClient.get<ResponseTemplate[]>('/cardinal/templates'),

  /** Create a new response template. Requires cardinal.admin. */
  createTemplate: (payload: TemplatePayload) =>
    governanceClient.post<ResponseTemplate>('/cardinal/templates', payload),

  /** Update a response template by id. Requires cardinal.admin. */
  updateTemplate: (id: number, payload: Partial<TemplatePayload>) =>
    governanceClient.put<ResponseTemplate>(`/cardinal/templates/${id}`, payload),

  /** Delete a response template by id. Requires cardinal.admin. */
  deleteTemplate: (id: number) =>
    governanceClient.delete(`/cardinal/templates/${id}`),
}
