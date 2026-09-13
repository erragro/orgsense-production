import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { cardinalApi } from '@/api/ingest/cardinal.api'
import { customersApi } from '@/api/governance/customers.api'
import { toast } from '@/stores/toast.store'
import {
  VALID_CHANNELS, VALID_SOURCES, VALID_BUSINESS_LINES, VALID_MODULES, SANDBOX_PRESETS,
  type Channel, type Source, type BusinessLine, type Module,
} from '@/lib/constants'
import type { IngestResponse } from '@/types/ticket.types'
import type { Customer } from '@/types/customer.types'
import { Zap } from 'lucide-react'

interface FormData {
  channel: Channel
  source: Source
  business_line: BusinessLine
  module: Module
  cx_email: string
  customer_id: string
  order_id: string
  subject: string
  description: string
  testMode: boolean
}

interface Props {
  onResult: (result: IngestResponse) => void
  onLoading: (loading: boolean) => void
}

export function SandboxSubmitPanel({ onResult, onLoading }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [customerSuggestions, setCustomerSuggestions] = useState<Customer[]>([])
  const [customerLookupLoading, setCustomerLookupLoading] = useState(false)

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormData>({
    defaultValues: {
      channel: 'email',
      source: 'api',
      business_line: 'ecommerce',
      module: 'delivery',
      testMode: true,
    },
  })

  const testMode = watch('testMode')
  const customerQuery = watch('customer_id') || ''

  useEffect(() => {
    let cancelled = false

    const fetchCustomers = async () => {
      const query = customerQuery.trim()
      if (query.length < 2) {
        setCustomerSuggestions([])
        return
      }

      setCustomerLookupLoading(true)
      try {
        const res = await customersApi.getList({ search: query, page: 1, limit: 6 })
        if (!cancelled) {
          setCustomerSuggestions(res.data.items ?? [])
        }
      } catch {
        if (!cancelled) {
          setCustomerSuggestions([])
        }
      } finally {
        if (!cancelled) {
          setCustomerLookupLoading(false)
        }
      }
    }

    fetchCustomers()
    return () => {
      cancelled = true
    }
  }, [customerQuery])

  const applyPreset = (presetIndex: number) => {
    if (presetIndex < 0) return
    const preset = SANDBOX_PRESETS[presetIndex]
    if (!preset) return
    const d = preset.data
    setValue('channel', d.channel)
    setValue('source', d.source)
    setValue('business_line', d.business_line)
    setValue('module', d.module)
    setValue('subject', d.subject)
    setValue('description', d.description)
  }

  const onSubmit = async (data: FormData) => {
    setSubmitting(true)
    onLoading(true)
    try {
      const payload = {
        channel: data.channel,
        source: data.source,
        org: 'sandbox_org',
        business_line: data.business_line,
        module: data.module,
        payload: {
          cx_email: data.cx_email || undefined,
          customer_id: data.customer_id || undefined,
          subject: data.subject,
          description: data.description,
          order_id: data.order_id || undefined,
        },
        metadata: {
          environment: 'sandbox' as const,
          called_by: 'manual' as const,
          test_mode: data.testMode,
        },
      }
      const res = await cardinalApi.ingest(payload)
      onResult(res.data)
      toast.success('Ticket submitted', `Execution ID: ${res.data.execution_id}`)
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } }
      toast.error('Submission failed', e.response?.data?.message ?? 'Unknown error')
    } finally {
      setSubmitting(false)
      onLoading(false)
    }
  }

  const makeOptions = (arr: readonly string[]) =>
    arr.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Submit Test Ticket</CardTitle>
          <Switch
            checked={testMode}
            onCheckedChange={(v) => setValue('testMode', v)}
            label="Test Mode"
          />
        </div>
      </CardHeader>
      <CardContent>
        {/* Presets */}
        <div className="mb-4">
          <p className="text-xs text-subtle mb-2">Quick presets:</p>
          <div className="flex flex-wrap gap-1.5">
            {SANDBOX_PRESETS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(i)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-surface-border bg-surface hover:bg-surface-card hover:border-brand-600/50 text-muted hover:text-foreground transition-colors"
              >
                <Zap className="w-2.5 h-2.5" />
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Channel"
              options={makeOptions(VALID_CHANNELS)}
              {...register('channel', { required: true })}
            />
            <Select
              label="Source"
              options={makeOptions(VALID_SOURCES)}
              {...register('source', { required: true })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Business Line"
              options={makeOptions(VALID_BUSINESS_LINES)}
              {...register('business_line', { required: true })}
            />
            <Select
              label="Module"
              options={makeOptions(VALID_MODULES)}
              {...register('module', { required: true })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Customer Email"
              placeholder="cx@example.com"
              {...register('cx_email')}
            />
            <div className="relative">
              <Input
                label="Customer ID"
                placeholder="Type 2+ chars to search"
                {...register('customer_id')}
              />
              {(customerLookupLoading || customerSuggestions.length > 0) && (
                <div className="absolute z-10 mt-1 w-full rounded border border-surface-border bg-surface-card shadow-lg">
                  {customerLookupLoading && (
                    <div className="px-3 py-2 text-xs text-subtle">Searching customers…</div>
                  )}
                  {!customerLookupLoading && customerSuggestions.map((customer) => (
                    <button
                      key={customer.customer_id}
                      type="button"
                      onClick={() => {
                        setValue('customer_id', customer.customer_id)
                        if (customer.email) {
                          setValue('cx_email', customer.email)
                        }
                        setCustomerSuggestions([])
                      }}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-surface"
                    >
                      <span className="font-medium">{customer.customer_id}</span>
                      <span className="text-subtle">{customer.email ?? 'no email'}</span>
                    </button>
                  ))}
                  {!customerLookupLoading && customerSuggestions.length === 0 && (
                    <div className="px-3 py-2 text-xs text-subtle">No matches</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <Input
            label="Order ID"
            placeholder="ORD-12345"
            {...register('order_id')}
          />

          <Input
            label="Subject *"
            placeholder="Brief description of the issue"
            error={errors.subject?.message}
            {...register('subject', { required: 'Subject is required' })}
          />

          <Textarea
            label="Description *"
            placeholder="Detailed description of the customer's issue..."
            className="min-h-[120px]"
            error={errors.description?.message}
            {...register('description', { required: 'Description is required' })}
          />

          <Button
            type="submit"
            loading={submitting}
            className="w-full"
          >
            Submit to Ingest Pipeline
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
