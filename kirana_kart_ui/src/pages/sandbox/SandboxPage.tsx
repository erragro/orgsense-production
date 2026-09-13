import { useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { SandboxSubmitPanel } from './SandboxSubmitPanel'
import { SandboxResultViewer } from './SandboxResultViewer'
import type { IngestResponse } from '@/types/ticket.types'

export default function SandboxPage() {
  const [result, setResult] = useState<IngestResponse | null>(null)
  const [loading, setLoading] = useState(false)

  return (
    <div>
      <PageHeader
        title="Sandbox"
        subtitle="Submit test tickets and watch the 5-phase pipeline process them in real time"
      />

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2">
          <SandboxSubmitPanel onResult={setResult} onLoading={setLoading} />
        </div>
        <div className="lg:col-span-3">
          <SandboxResultViewer result={result} loading={loading} />
        </div>
      </div>
    </div>
  )
}
