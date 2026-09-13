import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusPill } from '@/components/common/StatusPill'
import { StatCard } from '@/components/charts/StatCard'
import { customersApi } from '@/api/governance/customers.api'
import { formatDate, formatShortDate } from '@/lib/dates'
import { formatCurrency, formatPercent } from '@/lib/utils'
import { cn } from '@/lib/cn'
import { ArrowLeft } from 'lucide-react'

type Tab = 'overview' | 'orders' | 'tickets' | 'csat'

export default function CustomerDetailPage() {
  const { customerId } = useParams<{ customerId: string }>()
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  const { data: customer, isLoading } = useQuery({
    queryKey: ['customer', 'detail', customerId],
    queryFn: () => customersApi.getDetail(customerId!).then((r) => r.data),
    enabled: !!customerId,
  })

  const { data: orders } = useQuery({
    queryKey: ['customer', 'orders', customerId],
    queryFn: () => customersApi.getOrders(customerId!).then((r) => r.data),
    enabled: !!customerId && activeTab === 'orders',
  })

  const { data: tickets } = useQuery({
    queryKey: ['customer', 'tickets', customerId],
    queryFn: () => customersApi.getTickets(customerId!).then((r) => r.data),
    enabled: !!customerId && activeTab === 'tickets',
  })

  const { data: csat } = useQuery({
    queryKey: ['customer', 'csat', customerId],
    queryFn: () => customersApi.getCSAT(customerId!).then((r) => r.data),
    enabled: !!customerId && activeTab === 'csat',
  })

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-40" /></div>

  if (!customer) return (
    <div className="text-center py-16">
      <p className="text-muted">Customer not found or endpoint unavailable.</p>
      <Link to="/customers" className="text-brand-400 text-sm">← Back</Link>
    </div>
  )

  const churnProbability = customer.customer_churn_probability
  const churnRisk = churnProbability != null
    ? churnProbability > 0.7 ? 'high' : churnProbability > 0.4 ? 'medium' : 'low'
    : null

  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'orders', label: 'Orders' },
    { key: 'tickets', label: 'Tickets' },
    { key: 'csat', label: 'CSAT' },
  ]

  return (
    <div>
      <div className="mb-4">
        <Link to="/customers" className="flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" />Back to Customers
        </Link>
      </div>

      <PageHeader
        title={customer.email ?? customer.customer_id}
        subtitle={customer.customer_id}
        actions={
          <div className="flex gap-2">
            <Badge variant="blue">{customer.segment}</Badge>
            <Badge variant={customer.is_active ? 'green' : 'gray'}>{customer.is_active ? 'Active' : 'Inactive'}</Badge>
            {churnRisk === 'high' && <Badge variant="red">High Churn Risk</Badge>}
          </div>
        }
      />

      {/* Churn Warning */}
      {churnRisk === 'high' && (
        <Card className="mb-4 border-red-700/50 bg-red-900/10">
          <CardContent className="py-3">
            <p className="text-sm text-red-300">
              High churn probability: <span className="font-bold">{formatPercent(churnProbability!)}</span>.
              This customer is at significant risk of churning.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-surface-border">
        {TABS.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={cn('px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab.key ? 'border-brand-500 text-brand-400' : 'border-transparent text-muted hover:text-foreground')}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total Orders" value={customer.lifetime_order_count} />
            <StatCard label="IGCC Rate" value={`${customer.lifetime_igcc_rate.toFixed(2)}%`} />
            <StatCard label="Churn Probability" value={churnProbability ? formatPercent(churnProbability) : '—'} highlight={churnRisk === 'high' ? 'red' : churnRisk === 'medium' ? 'amber' : 'green'} />
            <StatCard label="Member Since" value={formatShortDate(customer.signup_date)} />
          </div>
          <Card>
            <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                {[
                  { label: 'Customer ID', value: customer.customer_id },
                  { label: 'Email', value: customer.email ?? '—' },
                  { label: 'Phone', value: customer.phone ?? '—' },
                  { label: 'Segment', value: customer.segment },
                  { label: 'Signup Date', value: formatDate(customer.signup_date) },
                  { label: 'Churn Model', value: customer.churn_model_version ?? '—' },
                  { label: 'Churn Updated', value: formatDate(customer.churn_last_updated) },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-xs text-subtle">{label}</p>
                    <p className="text-foreground font-mono text-xs mt-0.5">{value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'orders' && (
        <Card>
          <CardHeader><CardTitle>Order History</CardTitle></CardHeader>
          <CardContent className="p-0">
            {!orders?.length ? (
              <EmptyState title="No orders" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border">
                    {['Order ID', 'Value', 'Estimated', 'Actual', 'SLA'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {orders.map((o) => (
                    <tr key={o.order_id} className="hover:bg-surface-card/50">
                      <td className="px-4 py-3 font-mono text-xs text-brand-400">{o.order_id}</td>
                      <td className="px-4 py-3 font-mono text-green-300">{formatCurrency(o.order_value)}</td>
                      <td className="px-4 py-3 text-xs text-muted">{formatDate(o.delivery_estimated)}</td>
                      <td className="px-4 py-3 text-xs text-muted">{formatDate(o.delivery_actual)}</td>
                      <td className="px-4 py-3"><Badge variant={o.sla_breach ? 'red' : 'green'}>{o.sla_breach ? 'Breached' : 'On Time'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'tickets' && (
        <Card>
          <CardHeader><CardTitle>Ticket History</CardTitle></CardHeader>
          <CardContent className="p-0">
            {!tickets?.length ? (
              <EmptyState title="No tickets" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border">
                    {['Ticket', 'Subject', 'Module', 'Stage', 'Created'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {tickets.map((t) => (
                    <tr key={t.sl} className="hover:bg-surface-card/50">
                      <td className="px-4 py-3">
                        <Link to={`/tickets/${t.ticket_id}`} className="font-mono text-brand-400 text-xs">#{t.ticket_id}</Link>
                      </td>
                      <td className="px-4 py-3 text-foreground text-xs max-w-xs truncate">{t.subject ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-muted">{t.module ?? '—'}</td>
                      <td className="px-4 py-3"><StatusPill status={t.pipeline_stage} /></td>
                      <td className="px-4 py-3 text-xs text-subtle">{formatDate(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'csat' && (
        <Card>
          <CardHeader><CardTitle>CSAT Responses</CardTitle></CardHeader>
          <CardContent className="p-0">
            {!csat?.length ? (
              <EmptyState title="No CSAT data" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border">
                    {['Ticket', 'Rating', 'Feedback', 'Date'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {csat.map((c) => (
                    <tr key={c.id} className="hover:bg-surface-card/50">
                      <td className="px-4 py-3">
                        <Link to={`/tickets/${c.ticket_id}`} className="font-mono text-brand-400 text-xs">#{c.ticket_id}</Link>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <span key={i} className={cn('text-sm', i < c.rating ? 'text-amber-400' : 'text-subtle')}>★</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted max-w-xs truncate">{c.feedback ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-subtle">{formatDate(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
