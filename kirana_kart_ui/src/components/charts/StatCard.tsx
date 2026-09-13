import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/Card'
import { TrendingUp, TrendingDown } from 'lucide-react'

interface StatCardProps {
  label: string
  value: string | number
  subtitle?: string
  delta?: number
  deltaLabel?: string
  icon?: React.ReactNode
  className?: string
  highlight?: 'green' | 'red' | 'amber' | 'blue'
}

export function StatCard({ label, value, subtitle, delta, deltaLabel, icon, className, highlight }: StatCardProps) {
  const highlightBorder = {
    green: 'border-l-green-500',
    red: 'border-l-red-500',
    amber: 'border-l-amber-500',
    blue: 'border-l-blue-500',
  }

  return (
    <Card className={cn('border-l-4', highlight ? highlightBorder[highlight] : 'border-l-surface-border', className)}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-subtle uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold text-foreground mt-1">{value}</p>
            {subtitle && <p className="text-xs text-subtle mt-0.5">{subtitle}</p>}
            {delta != null && (
              <div className="flex items-center gap-1 mt-1">
                {delta >= 0 ? (
                  <TrendingUp className="w-3 h-3 text-green-400" />
                ) : (
                  <TrendingDown className="w-3 h-3 text-red-400" />
                )}
                <span className={cn('text-xs font-medium', delta >= 0 ? 'text-green-400' : 'text-red-400')}>
                  {delta > 0 ? '+' : ''}{delta}% {deltaLabel}
                </span>
              </div>
            )}
          </div>
          {icon && (
            <div className="p-2 rounded-lg bg-surface">{icon}</div>
          )}
        </div>
      </div>
    </Card>
  )
}
