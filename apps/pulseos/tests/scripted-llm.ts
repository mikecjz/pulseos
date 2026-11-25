/**
 * A keyless model endpoint that plays a fixed script of replies, for driving the real DSH
 * composition in tests. It answers Anthropic Messages (`POST …/messages`) and OpenAI Chat
 * Completions (`POST …/chat/completions`) streams. The step is the number of assistant messages
 * already in the request history, so retries and auxiliary requests (no PulseOS tools offered) do
 * not advance it, and a resumed conversation continues where it stopped.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ScriptStep = { tool: string; input: Record<string, unknown> } | { text: string }

interface ContentBlock { type: string; [key: string]: unknown }
interface MessagesRequest {
  /** Anthropic tools carry `name`; Chat Completions tools carry `function.name`. */
  tools?: { name?: string; function?: { name: string } }[]
  model?: string
  messages: { role: string; content: string | ContentBlock[] | null }[]
}

/** Path and headers of one scripted-conversation request. */
export interface RequestMeta {
  path: string
  headers: Record<string, string | string[] | undefined>
}

export interface ScriptedLlm {
  /** Base URL to use as DEEPSEEK_BASE_URL. */
  url: string
  /** Request bodies of the scripted conversation, in arrival order. */
  requests: MessagesRequest[]
  /** Path and headers of each entry of `requests`. */
  meta: RequestMeta[]
  close(): Promise<void>
}

function sse(response: ServerResponse, payload: Record<string, unknown>): void {
  response.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function reply(response: ServerResponse, step: ScriptStep, index: number): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  sse(response, { type: 'message_start', message: { id: `msg-${index}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
  if ('tool' in step) {
    sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${index}`, name: step.tool, input: {} } })
    sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } })
    sse(response, { type: 'content_block_stop', index: 0 })
    sse(response, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
  } else {
    sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } })
    sse(response, { type: 'content_block_stop', index: 0 })
    sse(response, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  }
  sse(response, { type: 'message_stop' })
  response.end()
}

function chatChunk(response: ServerResponse, index: number, delta: Record<string, unknown>, finish: string | null): void {
  const payload = { id: `chatcmpl-${index}`, object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] }
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function replyChat(response: ServerResponse, step: ScriptStep, index: number): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  chatChunk(response, index, { role: 'assistant', content: '' }, null)
  if ('tool' in step) {
    chatChunk(response, index, { tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: step.tool, arguments: '' } }] }, null)
    chatChunk(response, index, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.input) } }] }, null)
    chatChunk(response, index, {}, 'tool_calls')
  } else {
    chatChunk(response, index, { content: step.text }, null)
    chatChunk(response, index, {}, 'stop')
  }
  const usage = { id: `chatcmpl-${index}`, object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
  response.write(`data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`)
  response.end()
}

/**
 * Start the endpoint.
 * @param script - tool calls to make, then a final text.
 * @param toolPrefix - tool-name prefix that marks the scripted conversation's requests.
 * @returns the running endpoint.
 */
export async function startScriptedLlm(script: ScriptStep[], toolPrefix = 'seq_'): Promise<ScriptedLlm> {
  const requests: MessagesRequest[] = []
  const meta: RequestMeta[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0]!
      const answer = path.endsWith('/messages') ? reply : path.endsWith('/chat/completions') ? replyChat : undefined
      if (request.method !== 'POST' || answer === undefined) {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MessagesRequest
      if (!(body.tools ?? []).some(tool => (tool.name ?? tool.function?.name ?? '').startsWith(toolPrefix))) {
        answer(response, { text: 'PulseOS session' }, -1)
        return
      }
      requests.push(body)
      meta.push({ path, headers: request.headers })
      const step = body.messages.filter(m => m.role === 'assistant').length
      answer(response, script[step] ?? { text: 'Done.' }, step)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    meta,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/**
 * The tool results the model received, in order.
 * @param request - the last request of the conversation.
 * @returns name and text of each tool result.
 */
export function toolResults(request: MessagesRequest): { tool: string; text: string; isError: boolean }[] {
  const names = new Map<string, string>()
  const results: { tool: string; text: string; isError: boolean }[] = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(String(block.id), String(block.name))
      if (block.type === 'tool_result') {
        const content = block.content
        const text = typeof content === 'string' ? content : (content as ContentBlock[]).map(c => (c.type === 'text' ? String(c.text) : '')).join('')
        results.push({ tool: names.get(String(block.tool_use_id)) ?? '?', text, isError: block.is_error === true })
      }
    }
  }
  return results
}
