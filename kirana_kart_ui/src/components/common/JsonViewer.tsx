import { JsonView, allExpanded, defaultStyles } from 'react-json-view-lite'
import 'react-json-view-lite/dist/index.css'

interface JsonViewerProps {
  data: unknown
  expanded?: boolean
  maxHeight?: number
}

export function JsonViewer({ data, expanded = false, maxHeight = 384 }: JsonViewerProps) {
  if (data === null || data === undefined) {
    return <span className="text-subtle text-sm italic">null</span>
  }
  return (
    <div style={{ maxHeight }} className="text-xs font-mono bg-surface rounded-md p-3 overflow-auto max-h-96 border border-surface-border">
      <JsonView
        data={data as object}
        shouldExpandNode={expanded ? allExpanded : () => false}
        style={{
          ...defaultStyles,
          container: 'font-mono text-xs',
          basicChildStyle: 'ml-4',
          label: 'text-blue-600 dark:text-blue-300',
          stringValue: 'text-green-700 dark:text-green-300',
          numberValue: 'text-amber-700 dark:text-amber-300',
          booleanValue: 'text-purple-700 dark:text-purple-300',
          nullValue: 'text-subtle',
          undefinedValue: 'text-subtle',
        }}
      />
    </div>
  )
}
