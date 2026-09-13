import { useRef, useEffect, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Bell, AlertCircle, UserCheck, X, CheckCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import { crmApi } from '@/api/governance/crm.api'
import type { CRMNotification } from '@/types/crm.types'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function NotifIcon({ type }: { type: string }) {
  if (type === 'SLA_BREACHED' || type === 'SLA_WARNING' || type === 'FIRST_RESPONSE_BREACH') {
    return <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
  }
  if (type === 'ASSIGNED' || type === 'UNASSIGNED' || type === 'SELF_ASSIGN') {
    return <UserCheck className="w-4 h-4 text-blue-400 flex-shrink-0" />
  }
  return <Bell className="w-4 h-4 text-muted flex-shrink-0" />
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data } = useQuery({
    queryKey: ['crm-notifications'],
    queryFn: () => crmApi.getNotifications({ unread_only: false, page: 1, limit: 20 }).then(r => r.data),
    refetchInterval: 60_000,
  })

  const markRead = useMutation({
    mutationFn: (ids: number[]) => crmApi.markRead(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm-notifications'] }),
  })

  const markAll = useMutation({
    mutationFn: () => crmApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm-notifications'] }),
  })

  const unreadCount = data?.unread_count ?? 0
  const items: CRMNotification[] = data?.items ?? []

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  const handleNotifClick = useCallback((n: CRMNotification) => {
    if (!n.is_read) markRead.mutate([n.id])
    if (n.queue_id) navigate(`/crm/ticket/${n.queue_id}`)
    setOpen(false)
  }, [markRead, navigate])

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        className={cn(
          'relative p-2 rounded-md transition-colors',
          'text-muted hover:text-foreground hover:bg-surface-card',
          open && 'bg-surface-card text-foreground'
        )}
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 w-96 z-50 bg-surface-card border border-surface-border rounded-lg shadow-xl flex flex-col max-h-[520px]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border flex-shrink-0">
            <span className="text-sm font-semibold text-foreground">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={() => markAll.mutate()}
                  disabled={markAll.isPending}
                  className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 disabled:opacity-50"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  Mark all read
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded hover:bg-surface-border text-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted">
                <Bell className="w-8 h-8 opacity-30" />
                <p className="text-sm">No notifications</p>
              </div>
            ) : (
              <ul className="divide-y divide-surface-border">
                {items.map(n => (
                  <li
                    key={n.id}
                    className={cn(
                      'flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-surface-border/40 transition-colors',
                      !n.is_read && 'bg-brand-500/5'
                    )}
                  >
                    <div className="mt-0.5">
                      <NotifIcon type={n.type} />
                    </div>
                    <div
                      className="flex-1 min-w-0"
                      onClick={() => handleNotifClick(n)}
                    >
                      <p className={cn('text-xs font-medium truncate', n.is_read ? 'text-muted' : 'text-foreground')}>
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="text-xs text-muted mt-0.5 line-clamp-2">{n.body}</p>
                      )}
                      <p className="text-[10px] text-muted/60 mt-1">{timeAgo(n.created_at)}</p>
                    </div>
                    {!n.is_read && (
                      <button
                        onClick={e => { e.stopPropagation(); markRead.mutate([n.id]) }}
                        className="flex-shrink-0 mt-0.5 p-1 rounded hover:bg-surface-border text-muted hover:text-foreground"
                        title="Mark as read"
                      >
                        <CheckCheck className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {!n.is_read && (
                      <span className="w-2 h-2 rounded-full bg-brand-500 flex-shrink-0 mt-1.5" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
