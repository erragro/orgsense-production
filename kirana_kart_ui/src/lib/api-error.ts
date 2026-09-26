import { isAxiosError } from 'axios'

/**
 * The server's explanation for a failed request, when it gave one.
 * Axios' own message ("Request failed with status code 409") tells a
 * reviewer nothing about what to do next.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) return detail
    if (error.code === 'ECONNABORTED') return 'The request took too long. Check the proposal status before retrying.'
  }
  return fallback
}
