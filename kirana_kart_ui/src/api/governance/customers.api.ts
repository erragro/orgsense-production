import { governanceClient } from '../clients'
import type { Customer, Order, CSATResponse } from '@/types/customer.types'
import type { FdrawTicket } from '@/types/ticket.types'
import type { PaginatedResponse } from '@/types/api.types'

export const customersApi = {
  getList: (params: { search?: string; page?: number; limit?: number; segment?: string }) =>
    governanceClient.get<PaginatedResponse<Customer>>('/customers', { params }),

  getDetail: (customer_id: string) =>
    governanceClient.get<Customer>(`/customers/${customer_id}`),

  getOrders: (customer_id: string) =>
    governanceClient.get<Order[]>(`/customers/${customer_id}/orders`),

  getTickets: (customer_id: string) =>
    governanceClient.get<FdrawTicket[]>(`/customers/${customer_id}/tickets`),

  getCSAT: (customer_id: string) =>
    governanceClient.get<CSATResponse[]>(`/customers/${customer_id}/csat`),
}
