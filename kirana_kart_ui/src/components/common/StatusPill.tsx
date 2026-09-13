import { cn } from '@/lib/cn'

// Helper: merge light + dark class strings with optional pulse flag
const mk = (light: string, dark: string, pulse?: true) => ({
  className: `${light} ${dark}`,
  ...(pulse ? { pulse } : {}),
})

const STATUS_MAP: Record<string, { label: string; className: string; pulse?: boolean }> = {
  // Pipeline stages
  NEW:             { label: 'New',        ...mk('bg-slate-100 text-slate-600 border-slate-300',    'dark:bg-slate-700/50 dark:text-slate-300 dark:border-slate-600') },
  ENRICHED:        { label: 'Enriched',   ...mk('bg-cyan-100 text-cyan-700 border-cyan-300',       'dark:bg-cyan-900/40 dark:text-cyan-300 dark:border-cyan-700/50') },
  DISPATCHED:      { label: 'Dispatched', ...mk('bg-indigo-100 text-indigo-700 border-indigo-300', 'dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700/50') },
  IN_PROGRESS:     { label: 'In Progress',...mk('bg-blue-100 text-blue-700 border-blue-300',       'dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/50', true) },
  COMPLETED:       { label: 'Completed',  ...mk('bg-green-100 text-green-700 border-green-300',    'dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/50') },
  THREAD_RESOLVED: { label: 'Resolved',   ...mk('bg-emerald-100 text-emerald-700 border-emerald-300','dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700/50') },
  FAILED:          { label: 'Failed',     ...mk('bg-red-100 text-red-700 border-red-300',          'dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/50') },
  // Vector job statuses
  pending:   { label: 'Pending',   ...mk('bg-amber-100 text-amber-700 border-amber-300', 'dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/50') },
  running:   { label: 'Running',   ...mk('bg-blue-100 text-blue-700 border-blue-300',   'dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/50', true) },
  completed: { label: 'Completed', ...mk('bg-green-100 text-green-700 border-green-300', 'dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/50') },
  failed:    { label: 'Failed',    ...mk('bg-red-100 text-red-700 border-red-300',      'dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/50') },
  // Admin roles
  viewer:    { label: 'Viewer',    ...mk('bg-slate-100 text-slate-600 border-slate-300',   'dark:bg-slate-700/50 dark:text-slate-300 dark:border-slate-600') },
  editor:    { label: 'Editor',    ...mk('bg-blue-100 text-blue-700 border-blue-300',      'dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/50') },
  publisher: { label: 'Publisher', ...mk('bg-purple-100 text-purple-700 border-purple-300','dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-700/50') },
  // KB/policy statuses
  draft:     { label: 'Draft',     ...mk('bg-amber-100 text-amber-700 border-amber-300', 'dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/50') },
  published: { label: 'Published', ...mk('bg-green-100 text-green-700 border-green-300', 'dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/50') },
  active:    { label: 'Active',    ...mk('bg-green-100 text-green-700 border-green-300', 'dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/50') },
  inactive:  { label: 'Inactive',  ...mk('bg-slate-100 text-slate-500 border-slate-300', 'dark:bg-slate-700/50 dark:text-slate-400 dark:border-slate-600') },
  // Generic
  ok:        { label: 'OK',        ...mk('bg-green-100 text-green-700 border-green-300', 'dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/50') },
  error:     { label: 'Error',     ...mk('bg-red-100 text-red-700 border-red-300',       'dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/50') },
  healthy:   { label: 'Healthy',   ...mk('bg-green-100 text-green-700 border-green-300', 'dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/50') },
  degraded:  { label: 'Degraded',  ...mk('bg-amber-100 text-amber-700 border-amber-300', 'dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/50') },
  unhealthy: { label: 'Unhealthy', ...mk('bg-red-100 text-red-700 border-red-300',       'dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/50') },
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const config = STATUS_MAP[status] ?? {
    label: status,
    className: 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-700/50 dark:text-slate-300 dark:border-slate-600',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium',
        config.className,
        className
      )}
    >
      {config.pulse && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
      )}
      {config.label}
    </span>
  )
}
