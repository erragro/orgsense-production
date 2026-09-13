import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface PaginationBarProps {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  total?: number
  pageSize?: number
}

export function PaginationBar({ page, totalPages, onPageChange, total, pageSize }: PaginationBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-surface-border">
      <span className="text-xs text-subtle">
        {total != null && pageSize != null
          ? `Showing ${Math.min((page - 1) * pageSize + 1, total)}–${Math.min(page * pageSize, total)} of ${total}`
          : `Page ${page} of ${totalPages}`}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}
