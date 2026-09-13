export interface BIModule {
  issue_code: string      // segment value e.g. "swiggy"
  label: string           // display name e.g. "Swiggy"
  customer_count: number  // number of customers in this segment
}

export interface BIChatSession {
  id: number
  label: string
  created_at: string
  updated_at: string
}

export interface BIChatMessage {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  sql_query: string | null
  created_at: string
}

export type SSEEventType = 'status' | 'sql' | 'content' | 'done' | 'error'

export interface SSEEvent {
  type: SSEEventType
  text?: string
  query?: string
}
