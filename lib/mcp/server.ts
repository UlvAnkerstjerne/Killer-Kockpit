import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import * as z from 'zod/v4'
import { getAppOrigin } from '@/lib/app-url'
import {
  executeKockpitActionForActor,
  type KockpitActionResult,
} from '@/lib/kockpit-actions/service'
import type {
  KockpitActionsActor,
  KockpitActionsRepository,
} from '@/lib/kockpit-actions/repository'

const requestId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
const title = z.string().trim().min(1).max(500)
const nullableString = z.string().nullable().optional()
const priority = z.number().int().min(1).max(5).optional()

const createTodoInput = z.strictObject({
  request_id: requestId.describe('Stable unique request ID used to prevent duplicate creation.'),
  title,
  notes: nullableString,
  priority,
  scheduled_for: nullableString.describe('Optional ISO date or datetime.'),
})

const createTaskInput = z.strictObject({
  request_id: requestId.describe('Stable unique request ID used to prevent duplicate creation.'),
  title,
  description: nullableString,
  owner_user_id: nullableString.describe('Optional Kockpit owner ID. Defaults to the authenticated user.'),
  project_id: nullableString,
  priority,
  due_at: nullableString.describe('Optional ISO date or datetime.'),
})

const createOutput = z.strictObject({
  ok: z.literal(true),
  id: z.string().uuid(),
  title: z.string(),
  url: z.string().url(),
  duplicate: z.literal(true).optional(),
})

const oauthSecuritySchemes = [{ type: 'oauth2', scopes: ['email'] }]
const toolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const

type ExecuteAction = typeof executeKockpitActionForActor

export function createKockpitMcpServer(
  actor: KockpitActionsActor,
  repository?: KockpitActionsRepository,
  executeAction: ExecuteAction = executeKockpitActionForActor,
): McpServer {
  const server = new McpServer({ name: 'Killer Kockpit', version: '1.0.0' })

  server.registerTool('create_todo', {
    title: 'Create personal To-Do',
    description: 'Create one personal To-Do in Killer Kockpit for the authenticated user. No read, update, completion, or delete access.',
    inputSchema: createTodoInput,
    outputSchema: createOutput,
    annotations: toolAnnotations,
    _meta: { securitySchemes: oauthSecuritySchemes },
  }, async (input) => formatResult(await executeAction(
    input.request_id,
    { action: 'create_todo', ...input },
    actor,
    'chatgpt_mcp',
    repository,
  )))

  server.registerTool('create_task', {
    title: 'Create Task',
    description: 'Create one Task in Killer Kockpit as the authenticated user. No read, update, completion, or delete access.',
    inputSchema: createTaskInput,
    outputSchema: createOutput,
    annotations: toolAnnotations,
    _meta: { securitySchemes: oauthSecuritySchemes },
  }, async (input) => formatResult(await executeAction(
    input.request_id,
    { action: 'create_task', ...input },
    actor,
    'chatgpt_mcp',
    repository,
  )))

  return server
}

export async function handleKockpitMcpRequest(
  request: Request,
  actor: KockpitActionsActor,
  repository?: KockpitActionsRepository,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  const server = createKockpitMcpServer(actor, repository)
  await server.connect(transport)
  return transport.handleRequest(request)
}

function formatResult(result: KockpitActionResult) {
  if (!result.body.ok) {
    const error = result.body.error
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
    }
  }

  const structuredContent = {
    ok: true as const,
    id: result.body.id,
    title: result.body.title,
    url: new URL(result.body.url, getAppOrigin()).toString(),
    ...(result.body.duplicate ? { duplicate: true as const } : {}),
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}
