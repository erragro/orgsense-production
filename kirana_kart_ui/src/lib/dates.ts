import { format, formatDistanceToNow, parseISO, isValid } from 'date-fns'

export function formatDate(date: string | Date | null | undefined, fmt = 'dd MMM yyyy, HH:mm'): string {
  if (!date) return '—'
  const d = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(d)) return '—'
  return format(d, fmt)
}

export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(d)) return '—'
  return formatDistanceToNow(d, { addSuffix: true })
}

export function formatShortDate(date: string | Date | null | undefined): string {
  return formatDate(date, 'dd MMM yyyy')
}
