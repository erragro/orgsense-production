import { governanceClient } from '../clients'
import type {
  QASession,
  QAEvaluation,
  QAEvaluationSummary,
  QATicketResult,
  DismissedFlag,
  TicketSearchParams,
} from '@/types/qa.types'

export const qaApi = {
  getSessions: () =>
    governanceClient.get<QASession[]>('/qa-agent/sessions'),

  createSession: (label: string) =>
    governanceClient.post<QASession>('/qa-agent/sessions', { label }),

  renameSession: (id: number, label: string) =>
    governanceClient.patch<QASession>(`/qa-agent/sessions/${id}`, { label }),

  deleteSession: (id: number) =>
    governanceClient.delete(`/qa-agent/sessions/${id}`),

  getSessionEvaluations: (sessionId: number) =>
    governanceClient.get<QAEvaluationSummary[]>(`/qa-agent/sessions/${sessionId}/evaluations`),

  getEvaluation: (id: number) =>
    governanceClient.get<QAEvaluation>(`/qa-agent/evaluations/${id}`),

  searchTickets: (params: TicketSearchParams) =>
    governanceClient.get<QATicketResult[]>('/qa-agent/tickets/search', { params }),

  /** Governance admin: dismiss a Six Sigma or ML flag for a QA evaluation. */
  dismissFlag: (evaluationId: number, body: {
    parameter_name: string
    original_score: number
    dismiss_reason: string
    dismiss_note?: string
  }) =>
    governanceClient.post<{ status: string; parameter_name: string }>(
      `/qa-agent/evaluations/${evaluationId}/dismiss-flag`,
      body,
    ),

  /** Load all dismissed flags for an evaluation. */
  getFlags: (evaluationId: number) =>
    governanceClient.get<DismissedFlag[]>(`/qa-agent/evaluations/${evaluationId}/flags`),
}

// Note: POST /qa-agent/evaluate uses native fetch() for SSE streaming.
// See QAAgentPage.tsx for the streaming implementation.
