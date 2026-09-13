import { governanceClient } from '../clients'

export const simulationApi = {
  // Ticket search for simulation picker
  listTickets: (params?: { search?: string; limit?: number }) =>
    governanceClient.get('/simulation/tickets', { params }),

  getTicket: (ticketId: number) =>
    governanceClient.get(`/simulation/ticket/${ticketId}`),

  // Per-ticket simulation — local rule matching trace
  runTicket: (payload: { ticket_id: number; baseline_version: string; candidate_version: string }) =>
    governanceClient.post('/simulation/run-ticket', payload),

  // Full Cardinal simulation — all 4 stages (LLM + Weaviate + deterministic)
  runTicketCardinal: (payload: { ticket_id: number; baseline_version: string; candidate_version: string }) =>
    governanceClient.post('/simulation/run-ticket-cardinal', payload),

  // Batch simulation (original)
  run: (payload: { baseline_version: string; candidate_version: string }) =>
    governanceClient.post('/simulation/run', payload),

  health: () => governanceClient.get('/simulation/health'),
}
