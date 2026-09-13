import { governanceClient } from '../clients'
import type { FdrawTicket, TicketDetail } from '@/types/ticket.types'
import type { PaginatedResponse } from '@/types/api.types'

export const ticketsApi = {
  getList: (params: { page?: number; limit?: number; search?: string; module?: string; pipeline_stage?: string }) =>
    governanceClient.get<PaginatedResponse<FdrawTicket>>('/tickets/', { params }),

  getDetail: (ticket_id: number) =>
    governanceClient.get<TicketDetail>(`/tickets/${ticket_id}`),

  dispatch: (payload: { ticket_ids?: number[]; mode?: 'latest'; limit?: number }) =>
    governanceClient.post<{ dispatched: number; ticket_ids: number[]; stream: string }>('/tickets/dispatch', payload),
}
