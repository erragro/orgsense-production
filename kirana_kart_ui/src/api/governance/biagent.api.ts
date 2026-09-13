import { governanceClient } from '../clients'
import type { BIModule, BIChatSession, BIChatMessage } from '@/types/biagent.types'

export const biAgentApi = {
  getModules: () =>
    governanceClient.get<BIModule[]>('/bi-agent/modules'),

  getSessions: () =>
    governanceClient.get<BIChatSession[]>('/bi-agent/sessions'),

  createSession: (label: string) =>
    governanceClient.post<BIChatSession>('/bi-agent/sessions', { label }),

  renameSession: (id: number, label: string) =>
    governanceClient.patch<BIChatSession>(`/bi-agent/sessions/${id}`, { label }),

  deleteSession: (id: number) =>
    governanceClient.delete(`/bi-agent/sessions/${id}`),

  getMessages: (sessionId: number) =>
    governanceClient.get<BIChatMessage[]>(`/bi-agent/sessions/${sessionId}/messages`),
}
