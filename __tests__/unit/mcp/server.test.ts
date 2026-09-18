import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createKockpitMcpServer } from '@/lib/mcp/server'
import type { KockpitActionResult } from '@/lib/kockpit-actions/service'

const ACTOR = { id: '11111111-1111-4111-8111-111111111111', email: 'ulv@killerkebab.com', role: 'SUPER_ADMIN' as const }

describe('Kockpit MCP server', () => {
  const close: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(close.splice(0).map((fn) => fn()))
    vi.unstubAllEnvs()
  })

  async function connect(executor = vi.fn(async (): Promise<KockpitActionResult> => ({
    status: 200,
    body: {
      ok: true,
      action: 'create_todo',
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Created item',
      url: '/todos',
    },
  }))) {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://kockpit.example')
    const server = createKockpitMcpServer(ACTOR, undefined, executor)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(() => client.close(), () => server.close())
    return { client, executor }
  }

  it('advertises exactly the two authenticated, idempotent write tools', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(['create_todo', 'create_task'])
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      })
      expect(tool._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['email'] }])
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false })
    }
    expect(client.getServerCapabilities()).not.toHaveProperty('resources')
    expect(client.getServerCapabilities()).not.toHaveProperty('prompts')
  })

  it('binds creation to the server-resolved actor and chatgpt_mcp provenance', async () => {
    const { client, executor } = await connect()
    const result = await client.callTool({
      name: 'create_todo',
      arguments: { request_id: 'mcp-1', title: 'Created item' },
    })

    expect(result).toMatchObject({
      structuredContent: {
        ok: true,
        id: '22222222-2222-4222-8222-222222222222',
        url: 'https://kockpit.example/todos',
      },
    })
    expect(result.isError).not.toBe(true)
    expect(executor).toHaveBeenCalledWith(
      'mcp-1',
      expect.objectContaining({ action: 'create_todo', title: 'Created item' }),
      ACTOR,
      'chatgpt_mcp',
      undefined,
    )
  })

  it('rejects actor overrides and arbitrary fields before the action service runs', async () => {
    const { client, executor } = await connect()
    const result = await client.callTool({
      name: 'create_todo',
      arguments: { request_id: 'mcp-2', title: 'No', user_id: 'another-user' },
    })

    expect(result).toMatchObject({ isError: true })
    expect(executor).not.toHaveBeenCalled()
  })

  it('does not expose unsupported tools', async () => {
    const { client, executor } = await connect()
    const result = await client.callTool({ name: 'list_tasks', arguments: {} })
    expect(result).toMatchObject({ isError: true })
    expect(executor).not.toHaveBeenCalled()
  })

  it('returns bounded errors without stack traces or credentials', async () => {
    const executor = vi.fn(async (): Promise<KockpitActionResult> => ({
      status: 422,
      body: { ok: false, error: { code: 'invalid_project', message: 'Project does not exist.' } },
    }))
    const { client } = await connect(executor)
    const result = await client.callTool({
      name: 'create_task',
      arguments: { request_id: 'mcp-3', title: 'Task', project_id: 'missing' },
    })
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({ isError: true })
    expect(serialized).toContain('invalid_project')
    expect(serialized).not.toContain('stack')
    expect(serialized).not.toContain('SUPABASE_SECRET_KEY')
  })
})
