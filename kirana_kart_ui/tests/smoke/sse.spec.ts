import { test, expect } from '@playwright/test'
import { readSSEData } from '../../src/lib/sse'

test('SSE preserves fragmented Unicode, CRLF and multiline events', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: {"text":\r\ndata: "✓"}\r\n\r\ndata: next\n\ndata: unfinished')
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  const events = []
  for await (const event of readSSEData(body)) events.push(event)
  expect(events).toEqual(['{"text":\n"✓"}', 'next'])
})

test('SSE releases and cancels the stream when consumption stops', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')) },
    cancel() { cancelled = true },
  })
  for await (const _event of readSSEData(body)) break
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
