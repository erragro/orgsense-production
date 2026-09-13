import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/common/EmptyState'
import { compilerApi } from '@/api/governance/compiler.api'
import { toast } from '@/stores/toast.store'
import { cn } from '@/lib/cn'
import { CheckIcon, XIcon, Wand2 } from 'lucide-react'

interface Props {
  canAdmin: boolean
}

export function ActionCodesTab({ canAdmin }: Props) {
  const qc = useQueryClient()
  const [extractVersion, setExtractVersion] = useState('')
  const [extracting, setExtracting] = useState(false)

  const { data: actionCodes, isLoading } = useQuery({
    queryKey: ['compiler', 'action-codes'],
    queryFn: () => compilerApi.getActionCodes().then((r) => r.data),
  })

  const handleExtract = async () => {
    if (!extractVersion) { toast.error('Enter a version label'); return }
    setExtracting(true)
    try {
      const res = await compilerApi.extractActions(extractVersion)
      const { inserted_count, total_count } = res.data
      toast.success(
        'Extraction complete',
        `${inserted_count} new codes inserted — ${total_count} total`
      )
      void qc.invalidateQueries({ queryKey: ['compiler', 'action-codes'] })
    } catch {
      toast.error('Extraction failed')
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div className="space-y-4">
      {canAdmin && (
        <Card>
          <CardHeader><CardTitle>Extract from Document</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-subtle mb-3">
              Run an LLM pass over a KB document to identify all possible decision outcomes and
              upsert them into the master action codes registry.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="Version label (e.g. draft)"
                value={extractVersion}
                onChange={(e) => setExtractVersion(e.target.value)}
              />
              <Button
                onClick={handleExtract}
                loading={extracting}
                disabled={!extractVersion}
                variant="secondary"
              >
                <Wand2 className="w-3.5 h-3.5" />Extract
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Master Action Codes</CardTitle>
            {actionCodes && (
              <span className="text-xs text-subtle">{actionCodes.length} codes</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-subtle text-center">Loading…</div>
          ) : !actionCodes?.length ? (
            <EmptyState title="No action codes" description="Extract action codes from a document above." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-border">
                    <th className="text-left px-4 py-2 text-subtle font-medium">Code ID</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium">Name</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium hidden lg:table-cell">Description</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium">Refund</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium">Escalate</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium">Auto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {actionCodes.map((ac) => (
                    <tr key={ac.id} className="hover:bg-surface/50">
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-brand-400">{ac.action_code_id}</span>
                      </td>
                      <td className="px-4 py-2.5 text-foreground">{ac.action_name}</td>
                      <td className="px-4 py-2.5 text-subtle hidden lg:table-cell max-w-xs truncate">
                        {ac.action_description ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <BoolIcon value={ac.requires_refund} />
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <BoolIcon value={ac.requires_escalation} />
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <BoolIcon value={ac.automation_eligible} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function BoolIcon({ value }: { value: boolean }) {
  return value ? (
    <CheckIcon className={cn('w-3.5 h-3.5 mx-auto text-green-400')} />
  ) : (
    <XIcon className={cn('w-3.5 h-3.5 mx-auto text-subtle')} />
  )
}
