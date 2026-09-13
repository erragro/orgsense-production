import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatusPill } from '@/components/common/StatusPill'
import { VersionBadge } from '@/components/common/VersionBadge'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { kbApi } from '@/api/governance/kb.api'
import { toast } from '@/stores/toast.store'
import { formatDate } from '@/lib/dates'

interface Props {
  canAdmin: boolean
  onViewRules: (version: string) => void
}

export function VersionsTab({ canAdmin, onViewRules }: Props) {
  const qc = useQueryClient()
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null)

  const { data: versions, isLoading } = useQuery({
    queryKey: ['kb', 'versions'],
    queryFn: () => kbApi.getVersions().then((r) => r.data),
  })

  const { data: activeVersion } = useQuery({
    queryKey: ['kb', 'active-version'],
    queryFn: () => kbApi.getActiveVersion().then((r) => r.data),
  })

  const rollbackMut = useMutation({
    mutationFn: (v: string) => kbApi.rollback(v),
    onSuccess: () => {
      toast.success('KB rolled back')
      setRollbackTarget(null)
      void qc.invalidateQueries({ queryKey: ['kb'] })
    },
    onError: () => toast.error('Rollback failed'),
  })

  const active = activeVersion?.active_version

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Published Versions</CardTitle>
            {active && <VersionBadge version={active} isActive />}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-subtle text-center">Loading…</div>
          ) : !versions?.length ? (
            <EmptyState
              title="No published versions"
              description="Complete the pipeline workflow to publish your first version."
            />
          ) : (
            <div className="divide-y divide-surface-border">
              {versions.map((v) => (
                <div key={v.id} className="flex items-center gap-4 px-4 py-3">
                  <VersionBadge version={v.version_label} isActive={v.version_label === active} />
                  <StatusPill status={v.status} />
                  <span className="text-xs text-subtle flex-1">{v.created_by ?? '—'}</span>
                  <span className="text-xs text-subtle hidden sm:block">{formatDate(v.created_at)}</span>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => onViewRules(v.version_label)}
                    >
                      Rules
                    </Button>
                    {canAdmin && v.version_label !== active && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setRollbackTarget(v.version_label)}
                      >
                        Rollback
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={rollbackTarget != null}
        onClose={() => setRollbackTarget(null)}
        onConfirm={() => rollbackTarget && rollbackMut.mutate(rollbackTarget)}
        title={`Rollback to ${rollbackTarget}?`}
        description="This will revert the active knowledge base to the selected version. Ticket evaluation will use the rolled-back policy immediately."
        confirmLabel="Rollback"
        loading={rollbackMut.isPending}
      />
    </>
  )
}
