import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { StatusPill } from '@/components/common/StatusPill'
import { EmptyState } from '@/components/common/EmptyState'
import { kbApi } from '@/api/governance/kb.api'
import { toast } from '@/stores/toast.store'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { KB_FORMATS, type KBFormat } from '@/lib/constants'
import type { KBRawUpload } from '@/types/kb.types'
import { Upload, Pencil, X, Save } from 'lucide-react'

interface Props {
  canEdit: boolean
}

export function DocumentsTab({ canEdit }: Props) {
  const qc = useQueryClient()
  const [showUpload, setShowUpload] = useState(false)
  const [editingDoc, setEditingDoc] = useState<KBRawUpload | null>(null)

  const { data: uploads, isLoading } = useQuery({
    queryKey: ['kb', 'uploads'],
    queryFn: () => kbApi.getUploads().then((r) => r.data),
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-foreground">
          {uploads?.length ?? 0} document{uploads?.length !== 1 ? 's' : ''}
        </h2>
        {canEdit && (
          <Button size="sm" onClick={() => setShowUpload(true)}>
            <Upload className="w-3.5 h-3.5" />Upload Document
          </Button>
        )}
      </div>

      {showUpload && (
        <UploadPanel
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false)
            void qc.invalidateQueries({ queryKey: ['kb', 'uploads'] })
          }}
        />
      )}

      {editingDoc && (
        <EditPanel
          doc={editingDoc}
          onClose={() => setEditingDoc(null)}
          onSuccess={() => {
            setEditingDoc(null)
            void qc.invalidateQueries({ queryKey: ['kb', 'uploads'] })
          }}
        />
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-subtle text-center">Loading…</div>
          ) : !uploads?.length ? (
            <EmptyState title="No uploads yet" description="Upload your first KB document above." />
          ) : (
            <div className="divide-y divide-surface-border">
              {uploads.map((doc) => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  canEdit={canEdit}
                  onEdit={() => setEditingDoc(doc)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}


// ─── Document Row ────────────────────────────────────────────

function DocRow({
  doc,
  canEdit,
  onEdit,
}: {
  doc: KBRawUpload
  canEdit: boolean
  onEdit: () => void
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{doc.document_id}</p>
        <p className="text-xs text-subtle truncate">{doc.original_filename || '—'}</p>
      </div>
      <span className="text-xs text-subtle hidden sm:block">{doc.version_label}</span>
      <StatusPill status={doc.registry_status} />
      <span className="text-xs text-subtle hidden md:block">{formatDate(doc.uploaded_at)}</span>
      {canEdit && doc.registry_status === 'draft' && (
        <Button variant="ghost" size="xs" onClick={onEdit}>
          <Pencil className="w-3 h-3" />Edit
        </Button>
      )}
    </div>
  )
}


// ─── Upload Panel ────────────────────────────────────────────

function UploadPanel({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [docId, setDocId] = useState('')
  const [filename, setFilename] = useState('')
  const [format, setFormat] = useState<KBFormat>('markdown')
  const [versionLabel, setVersionLabel] = useState('draft')
  const [uploadedBy, setUploadedBy] = useState('')
  const [rawContent, setRawContent] = useState('')
  const [loading, setLoading] = useState(false)

  const handleFileLoad = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => setRawContent(ev.target?.result as string)
    reader.readAsText(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!docId || !rawContent) return
    setLoading(true)
    try {
      await kbApi.upload({
        document_id: docId,
        original_filename: filename,
        original_format: format,
        raw_content: rawContent,
        uploaded_by: uploadedBy,
        version_label: versionLabel,
      })
      toast.success('Document uploaded', `${docId} stored successfully`)
      onSuccess()
    } catch {
      toast.error('Upload failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Upload Document</CardTitle>
          <button onClick={onClose} className="text-subtle hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Document ID *"
              placeholder="delivery-policy-v2"
              value={docId}
              onChange={(e) => setDocId(e.target.value)}
              required
            />
            <Input
              label="Version Label"
              placeholder="draft"
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Format"
              options={KB_FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))}
              value={format}
              onChange={(e) => setFormat(e.target.value as KBFormat)}
            />
            <Input
              label="Uploaded By"
              placeholder="admin@company.com"
              value={uploadedBy}
              onChange={(e) => setUploadedBy(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted">Load from file</label>
            <input
              type="file"
              accept=".md,.txt,.json,.pdf,.docx"
              onChange={handleFileLoad}
              className="mt-1 block w-full text-xs text-muted file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-surface-card file:text-foreground hover:file:bg-surface"
            />
            {filename && <p className="text-xs text-subtle mt-0.5">Loaded: {filename}</p>}
          </div>

          <Textarea
            label="Raw Content *"
            placeholder="Paste document content here or load from file above…"
            className="min-h-[160px] font-mono text-xs"
            value={rawContent}
            onChange={(e) => setRawContent(e.target.value)}
            required
          />

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} disabled={!docId || !rawContent}>
              <Upload className="w-4 h-4" />Upload
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}


// ─── Edit Panel ───────────────────────────────────────────────

function EditPanel({
  doc,
  onClose,
  onSuccess,
}: {
  doc: KBRawUpload
  onClose: () => void
  onSuccess: () => void
}) {
  const [content, setContent] = useState(doc.raw_content ?? doc.markdown_content ?? '')
  const [format, setFormat] = useState<KBFormat>((doc.original_format as KBFormat) ?? 'markdown')
  const [loading, setLoading] = useState(false)

  const handleSave = async () => {
    setLoading(true)
    try {
      await kbApi.update(doc.id, { new_raw_content: content, original_format: format })
      toast.success('Document updated', doc.document_id)
      onSuccess()
    } catch {
      toast.error('Update failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className={cn('border border-brand-500/30')}>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Edit — {doc.document_id}</CardTitle>
          <div className="flex gap-2 items-center">
            <Select
              options={KB_FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))}
              value={format}
              onChange={(e) => setFormat(e.target.value as KBFormat)}
            />
            <button onClick={onClose} className="text-subtle hover:text-foreground ml-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          className="min-h-[320px] font-mono text-xs"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={loading} onClick={handleSave} disabled={!content}>
            <Save className="w-3.5 h-3.5" />Save Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
