export interface Customer {
  customer_id: string
  email: string | null
  phone: string | null
  date_of_birth: string | null
  signup_date: string
  is_active: boolean
  lifetime_order_count: number
  lifetime_igcc_rate: number
  segment: string
  customer_churn_probability: number | null
  churn_model_version: string | null
  churn_last_updated: string | null
}

export interface Order {
  order_id: string
  customer_id: string
  order_value: number
  delivery_estimated: string | null
  delivery_actual: string | null
  sla_breach: boolean
  created_at: string
  updated_at: string
}

export interface CSATResponse {
  id: number
  ticket_id: number
  rating: number
  feedback: string | null
  created_at: string
}

export interface CustomerDetail extends Customer {
  orders?: Order[]
  tickets?: import('./ticket.types').FdrawTicket[]
  csat?: CSATResponse[]
}
