import { cn } from '@/lib/cn'
import { Inbox } from 'lucide-react'

interface EmptyStateProps {
  icon?: React.ReactNode
  title?: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({
  icon = <Inbox className="w-8 h-8 text-subtle" />,
  title = 'No data found',
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 gap-3 text-center', className)}>
      {icon}
      <p className="text-sm font-medium text-muted">{title}</p>
      {description && <p className="text-xs text-subtle max-w-xs">{description}</p>}
      {action}
    </div>
  )
}
