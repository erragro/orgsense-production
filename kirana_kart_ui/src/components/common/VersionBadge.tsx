import { cn } from '@/lib/cn'

interface VersionBadgeProps {
  version: string
  isActive?: boolean
  isShadow?: boolean
  className?: string
}

export function VersionBadge({ version, isActive, isShadow, className }: VersionBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-xs font-mono font-medium',
        isActive && 'bg-green-100 text-green-700 border-green-300 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/50',
        isShadow && 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/50',
        !isActive && !isShadow && 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-700/50 dark:text-slate-300 dark:border-slate-600',
        className
      )}
    >
      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-green-400" />}
      {isShadow && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
      {version}
    </span>
  )
}
