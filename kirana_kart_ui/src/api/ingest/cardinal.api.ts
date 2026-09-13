import { ingestClient } from '../clients'
import type { CardinalIngestPayload, IngestResponse } from '@/types/ticket.types'

export const cardinalApi = {
  ingest: (payload: CardinalIngestPayload) =>
    ingestClient.post<IngestResponse>('/cardinal/ingest', payload),
}
