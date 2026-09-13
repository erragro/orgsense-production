import { Fragment } from 'react'
import { cn } from '@/lib/cn'

// ─── Inline parser: **bold**, *italic*, `code` ─────────────────────────────

function parseInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re = /\*\*(.+?)\*\*|\*([^*\n]+?)\*|`([^`\n]+?)`/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>)
    if (m[1] !== undefined)
      parts.push(<strong key={i++} className="font-semibold text-foreground">{m[1]}</strong>)
    else if (m[2] !== undefined)
      parts.push(<em key={i++} className="italic">{m[2]}</em>)
    else if (m[3] !== undefined)
      parts.push(
        <code key={i++} className="bg-surface-border/60 text-brand-500 px-1 py-0.5 rounded text-[0.8em] font-mono">
          {m[3]}
        </code>
      )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(<Fragment key={i++}>{text.slice(last)}</Fragment>)
  return parts
}

// ─── Block-level parser ────────────────────────────────────────────────────

interface Block {
  type: 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'hr' | 'para' | 'blockquote'
  content: string        // for single-line blocks
  items?: string[]       // for list blocks
}

function tokenize(raw: string): Block[] {
  const lines = raw.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Skip blank
    if (line.trim() === '') { i++; continue }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'hr', content: '' })
      i++; continue
    }

    // Headings
    const h3 = line.match(/^###\s+(.+)/)
    const h2 = line.match(/^##\s+(.+)/)
    const h1 = line.match(/^#\s+(.+)/)
    if (h3) { blocks.push({ type: 'h3', content: h3[1] }); i++; continue }
    if (h2) { blocks.push({ type: 'h2', content: h2[1] }); i++; continue }
    if (h1) { blocks.push({ type: 'h1', content: h1[1] }); i++; continue }

    // Bullet list (allow leading whitespace for indented bullets like "  - item")
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''))
        i++
      }
      blocks.push({ type: 'bullet', content: '', items })
      continue
    }

    // Numbered list (allow leading whitespace)
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push({ type: 'ordered', content: '', items })
      continue
    }

    // Blockquote (starts with >)
    if (/^>\s*/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^>\s*/.test(lines[i])) {
        items.push(lines[i].replace(/^>\s*/, ''))
        i++
      }
      blocks.push({ type: 'blockquote', content: '', items })
      continue
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim()) &&
      !/^>\s*/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'para', content: paraLines.join(' ') })
    }
  }
  return blocks
}

// ─── Renderer ─────────────────────────────────────────────────────────────

interface Props {
  text: string
  className?: string
}

export function MarkdownContent({ text, className }: Props) {
  const blocks = tokenize(text)

  return (
    <div className={cn('space-y-1.5 text-sm leading-relaxed', className)}>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'h1':
            return (
              <h2 key={idx} className="text-base font-bold text-foreground mt-3 mb-1">
                {parseInline(block.content)}
              </h2>
            )
          case 'h2':
            return (
              <h3 key={idx} className="text-sm font-bold text-foreground mt-2 mb-0.5">
                {parseInline(block.content)}
              </h3>
            )
          case 'h3':
            return (
              <h4 key={idx} className="text-sm font-semibold text-muted mt-2 mb-0.5">
                {parseInline(block.content)}
              </h4>
            )
          case 'bullet':
            return (
              <ul key={idx} className="list-disc pl-5 space-y-0.5 text-foreground">
                {(block.items ?? []).map((item, j) => (
                  <li key={j}>{parseInline(item)}</li>
                ))}
              </ul>
            )
          case 'ordered':
            return (
              <ol key={idx} className="list-decimal pl-5 space-y-0.5 text-foreground">
                {(block.items ?? []).map((item, j) => (
                  <li key={j}>{parseInline(item)}</li>
                ))}
              </ol>
            )
          case 'blockquote':
            return (
              <blockquote
                key={idx}
                className="pl-3 border-l-2 border-brand-500/50 text-muted italic"
              >
                {(block.items ?? []).map((item, j) => (
                  <p key={j}>{parseInline(item)}</p>
                ))}
              </blockquote>
            )
          case 'hr':
            return <hr key={idx} className="border-surface-border my-2" />
          case 'para':
          default:
            return (
              <p key={idx} className="text-foreground">
                {parseInline(block.content)}
              </p>
            )
        }
      })}
    </div>
  )
}
