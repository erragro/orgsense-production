import { useQuery } from '@tanstack/react-query'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { governanceSystemApi } from '@/api/governance/system.api'
import type { SystemStatus } from '@/types/system.types'

export function AppShell() {
  const { data: status } = useQuery({
    queryKey: ['system', 'status', 'governance'],
    queryFn: () => governanceSystemApi.systemStatus().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const systemHealthStatus = (status as SystemStatus | undefined)?.status

  return (
    <div className="flex min-h-screen bg-surface text-foreground">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar systemHealthStatus={systemHealthStatus} />
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
