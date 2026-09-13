/** Decode SSE data events independently of transport chunk boundaries. */
export async function* readSSEData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        if (frame.length > 1_048_576) throw new Error('SSE event exceeds size limit')
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
        if (data.length) yield data.join('\n')
      }
      if (buffer.length > 1_048_576) throw new Error('SSE event exceeds size limit')
      if (done) break // Unterminated events are not dispatched by SSE.
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
