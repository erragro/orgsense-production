export interface ApiError {
  status: 'error'
  error_code: string
  message: string
  detail?: unknown
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
}
