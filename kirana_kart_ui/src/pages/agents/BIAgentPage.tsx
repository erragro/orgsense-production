import { readSSEData } from '@/lib/sse'
import { useState,useRef,useEffect,useCallback } from 'react'
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query'
import {
BrainCircuit,Plus,Trash2,Send,ChevronDown,ChevronUp,
Loader2,AlertTriangle,MessageSquare,Database,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { biAgentApi } from '@/api/governance/biagent.api'
import { getAccessToken } from '@/api/interceptors'
import { useToastStore } from '@/stores/toast.store'
import { CopyButton } from '@/components/common/CopyButton'
import { MarkdownContent } from '@/components/common/MarkdownContent'
import { Spinner } from '@/components/ui/Spinner'
import type { BIChatSession,BIChatMessage,SSEEvent } from '@/types/biagent.types'

const GOVERNANCE_URL = import.meta.env.VITE_GOVERNANCE_API_URL ?? (import.meta.env.PROD ? '/api/governance' : 'http://localhost:8001')

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveMessage {
  id: string            // temp client-side id
  role: 'user' | 'assistant'
  content: string
  sqlQuery?: string
  status?: string       // current status chip text (clears when done)
  streaming?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function uid() {
  return Math.random().toString(36).slice(2)
}

// ─── SQL Block ────────────────────────────────────────────────────────────────

function SqlBlock({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 rounded-md border border-surface-border overflow-hidden text-xs">
      {/* Header row: toggle button + copy button as siblings (no nested buttons) */}
      <div className="flex items-center bg-surface hover:bg-surface-border/50 transition-colors">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 px-3 py-1.5 text-muted text-left"
        >
          <Database className="w-3 h-3 shrink-0 text-brand-500" />
          <span className="font-mono text-brand-500">SQL</span>
          <span className="flex-1 min-w-0 truncate text-subtle">{sql.slice(0, 60)}…</span>
          {open ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
        </button>
        <div className="px-2 shrink-0">
          <CopyButton text={sql} />
        </div>
      </div>
      {open && (
        <pre className="px-3 py-2 bg-surface-card text-foreground font-mono overflow-x-auto whitespace-pre-wrap break-all">
          {sql}
        </pre>
      )}
    </div>
  )
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: LiveMessage }) {
  const isUser = msg.role === 'user'
  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold',
        isUser
          ? 'bg-brand-600 text-white'
          : 'bg-surface-border text-muted'
      )}>
        {isUser ? 'U' : <BrainCircuit className="w-4 h-4" />}
      </div>

      <div className={cn('flex flex-col gap-1 max-w-[80%]', isUser && 'items-end')}>
        {/* Status chip */}
        {msg.status && (
          <div className="flex items-center gap-1.5 text-xs text-subtle">
            <Loader2 className="w-3 h-3 animate-spin" />
            {msg.status}
          </div>
        )}

        {/* Content */}
        {msg.content && (
          <div className={cn(
            'rounded-xl px-4 py-2.5',
            isUser
              ? 'bg-brand-600 text-white rounded-tr-sm text-sm leading-relaxed whitespace-pre-wrap'
              : 'bg-surface-card border border-surface-border text-foreground rounded-tl-sm'
          )}>
            {isUser
              ? msg.content
              : <MarkdownContent text={msg.content} />
            }
            {msg.streaming && (
              <span className="inline-flex gap-0.5 ml-1 align-middle">
                <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </div>
        )}

        {/* SQL block */}
        {msg.sqlQuery && <SqlBlock sql={msg.sqlQuery} />}
      </div>
    </div>
  )
}

// ─── Filter Banner ────────────────────────────────────────────────────────────

function FilterBanner() {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg text-xs text-amber-700 dark:text-amber-300">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      Select a <strong>Segment</strong> and <strong>Date Range</strong> above to activate the chat.
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BIAgentPage() {
  const { addToast } = useToastStore()
  const qc = useQueryClient()

  // ── Sessions ────────────────────────────────────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editLabel, setEditLabel] = useState('')

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['bi-sessions'],
    queryFn: () => biAgentApi.getSessions().then(r => r.data),
  })

  const createSession = useMutation({
    mutationFn: () => biAgentApi.createSession('New Chat').then(r => r.data),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['bi-sessions'] })
      setActiveSessionId(s.id)
      setLiveMessages([])
    },
    onError: () => {
      addToast({ type: 'error', title: 'Failed to create new chat. Please try again.' })
    },
  })

  const renameSession = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) =>
      biAgentApi.renameSession(id, label),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bi-sessions'] })
      setEditingId(null)
    },
  })

  const deleteSession = useMutation({
    mutationFn: (id: number) => biAgentApi.deleteSession(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['bi-sessions'] })
      if (activeSessionId === id) {
        setActiveSessionId(null)
        setLiveMessages([])
      }
    },
  })

  // ── Modules ──────────────────────────────────────────────────────────────────
  const { data: modules = [] } = useQuery({
    queryKey: ['bi-modules'],
    queryFn: () => biAgentApi.getModules().then(r => r.data),
  })

  // Segments are flat — no hierarchy needed

  // ── Filters ──────────────────────────────────────────────────────────────────
  const [module, setModule] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filtersApplied, setFiltersApplied] = useState(false)

  const filtersValid = Boolean(module && dateFrom && dateTo && dateFrom <= dateTo)
  const chatEnabled = filtersValid && filtersApplied && activeSessionId !== null

  const handleApplyFilters = () => {
    if (filtersValid) setFiltersApplied(true)
  }

  // Reset applied state when filters change
  useEffect(() => { setFiltersApplied(false) }, [module, dateFrom, dateTo])

  // ── Messages ─────────────────────────────────────────────────────────────────
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([])
  const [question, setQuestion] = useState('')
  const [streaming, setStreaming] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Load persisted messages when session changes
  const { data: persistedMessages } = useQuery({
    queryKey: ['bi-messages', activeSessionId],
    queryFn: () =>
      activeSessionId
        ? biAgentApi.getMessages(activeSessionId).then(r => r.data)
        : Promise.resolve([]),
    enabled: activeSessionId !== null,
  })

  useEffect(() => {
    if (persistedMessages) {
      setLiveMessages(
        persistedMessages.map((m: BIChatMessage) => ({
          id: String(m.id),
          role: m.role,
          content: m.content,
          sqlQuery: m.sql_query ?? undefined,
        }))
      )
    }
  }, [persistedMessages])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveMessages])

  // ── Send query ───────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!chatEnabled || !question.trim() || streaming || !activeSessionId) return

    const q = question.trim()
    setQuestion('')
    setStreaming(true)

    // Add user message
    const userMsgId = uid()
    const assistantMsgId = uid()

    setLiveMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user', content: q },
      { id: assistantMsgId, role: 'assistant', content: '', status: 'Thinking…', streaming: true },
    ])

    abortRef.current = new AbortController()

    try {
      const res = await fetch(`${GOVERNANCE_URL}/bi-agent/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getAccessToken() ?? ''}`,
        },
        body: JSON.stringify({
          session_id: activeSessionId,
          question: q,
          module,
          date_from: dateFrom,
          date_to: dateTo,
        }),
        signal: abortRef.current.signal,
      })

      if (!res.ok || !res.body) {
        throw new Error(`Server error: ${res.status}`)
      }

      let completed = false
      for await (const data of readSSEData(res.body)) {
          try {
            const evt: SSEEvent = JSON.parse(data)

            if (evt.type === 'done' || evt.type === 'error') completed = true
            if (evt.type === 'status') {
              setLiveMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, status: evt.text } : m
              ))
            } else if (evt.type === 'sql') {
              setLiveMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, sqlQuery: evt.query, status: undefined } : m
              ))
            } else if (evt.type === 'content') {
              setLiveMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? { ...m, content: m.content + (evt.text ?? ''), status: undefined }
                  : m
              ))
            } else if (evt.type === 'done') {
              setLiveMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, streaming: false, status: undefined } : m
              ))
              // Refresh persisted messages in background
              qc.invalidateQueries({ queryKey: ['bi-messages', activeSessionId] })
              qc.invalidateQueries({ queryKey: ['bi-sessions'] })
            } else if (evt.type === 'error') {
              setLiveMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? { ...m, content: `⚠ ${evt.text}`, streaming: false, status: undefined }
                  : m
              ))
            }
          } catch {
            // ignore parse errors
          }
      }
      if (!completed) throw new Error('Stream ended before completion')
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        setLiveMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, content: '⚠ Connection error. Is the backend running?', streaming: false, status: undefined }
            : m
        ))
      }
    } finally {
      setLiveMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, streaming: false } : m))
      setStreaming(false)
    }
  }, [chatEnabled, question, streaming, activeSessionId, module, dateFrom, dateTo, qc])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Select first session on load
  useEffect(() => {
    if (sessions.length > 0 && activeSessionId === null) {
      setActiveSessionId(sessions[0].id)
    }
  }, [sessions, activeSessionId])

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-56px)] overflow-hidden">

      {/* ── Chat sessions sidebar ─────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-surface-border bg-surface-card">
        <div className="px-3 py-3 border-b border-surface-border">
          <button
            onClick={() => createSession.mutate()}
            disabled={createSession.isPending}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-60"
          >
            {createSession.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Plus className="w-4 h-4" />
            }
            New Chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {sessionsLoading && (
            <div className="flex justify-center py-6"><Spinner size="sm" /></div>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <p className="text-xs text-subtle text-center py-6">No chats yet.</p>
          )}
          {sessions.map((s: BIChatSession) => (
            <div
              key={s.id}
              className={cn(
                'group flex items-center gap-1.5 px-2 py-2 rounded-md cursor-pointer transition-colors',
                activeSessionId === s.id
                  ? 'bg-brand-600/20 text-brand-400'
                  : 'hover:bg-surface text-muted hover:text-foreground'
              )}
              onClick={() => {
                setActiveSessionId(s.id)
                setLiveMessages([])
              }}
            >
              <MessageSquare className="w-3.5 h-3.5 shrink-0" />

              {editingId === s.id ? (
                <input
                  autoFocus
                  className="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border-b border-brand-500"
                  value={editLabel}
                  onChange={e => setEditLabel(e.target.value)}
                  onBlur={() => {
                    if (editLabel.trim()) renameSession.mutate({ id: s.id, label: editLabel.trim() })
                    else setEditingId(null)
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      if (editLabel.trim()) renameSession.mutate({ id: s.id, label: editLabel.trim() })
                      else setEditingId(null)
                    }
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span
                  className="flex-1 min-w-0 text-xs truncate"
                  onDoubleClick={e => {
                    e.stopPropagation()
                    setEditingId(s.id)
                    setEditLabel(s.label)
                  }}
                  title="Double-click to rename"
                >
                  {s.label}
                </span>
              )}

              <span className="text-xs text-subtle shrink-0 hidden group-hover:block">
                {formatDate(s.updated_at)}
              </span>

              <button
                className="shrink-0 text-subtle hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                onClick={e => {
                  e.stopPropagation()
                  deleteSession.mutate(s.id)
                }}
                title="Delete chat"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main panel ────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Filter card */}
        <div className="shrink-0 border-b border-surface-border bg-surface-card px-6 py-4">
          <h1 className="text-base font-semibold text-foreground flex items-center gap-2 mb-3">
            <BrainCircuit className="w-4 h-4 text-brand-500" />
            BI Agent
            <span className="text-xs font-normal text-subtle">— Senior Business Analyst</span>
          </h1>

          <div className="flex flex-wrap items-end gap-3">
            {/* Segment */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted">
                Segment <span className="text-red-400">*</span>
              </label>
              <select
                value={module}
                onChange={e => setModule(e.target.value)}
                className={cn(
                  'h-9 px-3 rounded-md border text-sm bg-surface text-foreground',
                  'focus:outline-none focus:ring-2 focus:ring-brand-500/40',
                  !module ? 'border-amber-400 dark:border-amber-600' : 'border-surface-border',
                )}
              >
                <option value="">Select segment…</option>
                {modules.map(seg => (
                  <option key={seg.issue_code} value={seg.issue_code}>
                    {seg.label} ({seg.customer_count.toLocaleString()} customers)
                  </option>
                ))}
              </select>
            </div>

            {/* Date From */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted">
                From <span className="text-red-400">*</span>
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className={cn(
                  'h-9 px-3 rounded-md border text-sm bg-surface text-foreground',
                  'focus:outline-none focus:ring-2 focus:ring-brand-500/40',
                  !dateFrom ? 'border-amber-400 dark:border-amber-600' : 'border-surface-border',
                )}
              />
            </div>

            {/* Date To */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted">
                To <span className="text-red-400">*</span>
              </label>
              <input
                type="date"
                value={dateTo}
                min={dateFrom}
                onChange={e => setDateTo(e.target.value)}
                className={cn(
                  'h-9 px-3 rounded-md border text-sm bg-surface text-foreground',
                  'focus:outline-none focus:ring-2 focus:ring-brand-500/40',
                  !dateTo ? 'border-amber-400 dark:border-amber-600' : 'border-surface-border',
                )}
              />
            </div>

            {/* Apply */}
            <button
              onClick={handleApplyFilters}
              disabled={!filtersValid}
              className={cn(
                'h-9 px-4 rounded-md text-sm font-medium transition-colors',
                filtersValid
                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                  : 'bg-surface-border text-subtle cursor-not-allowed'
              )}
            >
              Apply Filters
            </button>

            {filtersApplied && (
              <span className="text-xs text-green-500 flex items-center gap-1">
                ✓ Filters applied
              </span>
            )}
          </div>

          {/* Validation hints */}
          {(!module || !dateFrom || !dateTo) && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {!module && '· Select a segment '}
              {!dateFrom && '· Set a start date '}
              {!dateTo && '· Set an end date'}
            </p>
          )}
        </div>

        {/* No session selected */}
        {activeSessionId === null && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-subtle">
            <BrainCircuit className="w-12 h-12 opacity-20" />
            <p className="text-sm">Create or select a chat to get started.</p>
            <button
              onClick={() => createSession.mutate()}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700 transition-colors"
            >
              <Plus className="w-4 h-4" /> New Chat
            </button>
          </div>
        )}

        {/* Chat area */}
        {activeSessionId !== null && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {liveMessages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-3 text-subtle">
                  <BrainCircuit className="w-10 h-10 opacity-20" />
                  <p className="text-sm text-center max-w-sm">
                    {chatEnabled
                      ? 'Ask a business question — e.g. "What was our CSAT score last month?" or "Show me SLA breach rate by channel"'
                      : 'Apply filters above to start the conversation.'}
                  </p>
                </div>
              )}

              {liveMessages.map(msg => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="shrink-0 border-t border-surface-border bg-surface-card px-6 py-4">
              {!chatEnabled && <FilterBanner />}

              <div className={cn(
                'flex gap-2 mt-2',
                !chatEnabled && 'opacity-50 pointer-events-none'
              )}>
                <textarea
                  rows={2}
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={!chatEnabled || streaming}
                  placeholder={
                    !filtersApplied
                      ? 'Fill Segment and Date Range above to start…'
                      : 'Ask a business question… (Enter to send, Shift+Enter for new line)'
                  }
                  className={cn(
                    'flex-1 resize-none rounded-lg border border-surface-border bg-surface',
                    'px-3 py-2 text-sm text-foreground placeholder:text-subtle',
                    'focus:outline-none focus:ring-2 focus:ring-brand-500/40',
                    'disabled:cursor-not-allowed'
                  )}
                />
                <button
                  onClick={handleSend}
                  disabled={!chatEnabled || !question.trim() || streaming}
                  className={cn(
                    'flex items-center justify-center w-10 h-10 self-end rounded-lg transition-colors',
                    chatEnabled && question.trim() && !streaming
                      ? 'bg-brand-600 text-white hover:bg-brand-700'
                      : 'bg-surface-border text-subtle cursor-not-allowed'
                  )}
                >
                  {streaming
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Send className="w-4 h-4" />
                  }
                </button>
              </div>

              <p className="mt-1.5 text-xs text-subtle">
                Responses are AI-generated based on live database queries. Always verify critical figures.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
