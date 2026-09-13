import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { SearchInput } from '@/components/common/SearchInput'
import { PaginationBar } from '@/components/common/PaginationBar'
import { EmptyState } from '@/components/common/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { customersApi } from '@/api/governance/customers.api'
import { Users } from 'lucide-react'

const PAGE_SIZE = 25

function ChurnBadge({ probability }: { probability: number | null }) {
  if (probability == null) return <span className="text-subtle text-xs">—</span>
  const pct = (probability * 100).toFixed(0)
  const variant = probability > 0.7 ? 'red' : probability > 0.4 ? 'amber' : 'green'
  return <Badge variant={variant}>{pct}%</Badge>
}

export default function CustomerListPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customers', 'list', { page, search }],
    queryFn: () => customersApi.getList({ search: search || undefined, page, limit: PAGE_SIZE }).then((r) => r.data),
  })

  return (
    <div>
      <PageHeader title="Customers" subtitle="Search and browse customer profiles" />

      <div className="flex gap-3 mb-4">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="Search by email or customer ID…" />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : isError ? (
            <EmptyState title="Failed to load customers" description="Could not reach the governance plane. Ensure the backend is running on port 8001." />
          ) : !data?.items?.length ? (
            <EmptyState icon={<Users className="w-8 h-8 text-subtle" />} title="No customers found" />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border">
                    {['Customer ID', 'Email', 'Segment', 'Orders', 'IGCC Rate', 'Churn Risk', 'Status'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {data.items.map((c) => (
                    <tr key={c.customer_id} className="hover:bg-surface-card/50 transition-colors">
                      <td className="px-4 py-3">
                        <Link to={`/customers/${c.customer_id}`} className="font-mono text-brand-400 hover:text-brand-300 text-xs">{c.customer_id}</Link>
                      </td>
                      <td className="px-4 py-3 text-muted text-xs">{c.email ?? '—'}</td>
                      <td className="px-4 py-3"><Badge variant="blue">{c.segment}</Badge></td>
                      <td className="px-4 py-3 text-foreground">{c.lifetime_order_count}</td>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">{c.lifetime_igcc_rate.toFixed(2)}%</td>
                      <td className="px-4 py-3"><ChurnBadge probability={c.customer_churn_probability} /></td>
                      <td className="px-4 py-3"><Badge variant={c.is_active ? 'green' : 'gray'}>{c.is_active ? 'Active' : 'Inactive'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.total_pages > 1 && (
                <PaginationBar page={page} totalPages={data.total_pages} onPageChange={setPage} total={data.total} pageSize={PAGE_SIZE} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
