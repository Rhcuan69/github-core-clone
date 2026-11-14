// MCP over streamable HTTP (POST /mcp): the modern 2026-07-28 era via
// server/discover, plus the legacy initialize handshake. Plain JSON-RPC 2.0.

import {
  createIssue,
  createPull,
  getIssue,
  issueJson,
  listIssues,
  mergePull,
  pullJson,
  repoJson,
  type RestCtx,
} from './rest.ts';
import { VIEWER, type Store } from './store.ts';

export interface McpResponse {
  status: number;
  body: Buffer;
}

const SERVER_INFO = { name: 'github-core-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      private: { type: 'boolean' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: { owner: { type: 'string' }, repo: { type: 'string' } },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      head: { type: 'string' },
      base: { type: 'string' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function jsonRpc(id: unknown, result: unknown): Buffer {
  return Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8');
}

function jsonRpcError(id: unknown, code: number, message: string): Buffer {
  return Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`, 'utf8');
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
}

export function handleMcp(store: Store, rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: jsonRpcError(null, -32700, 'Parse error') };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: jsonRpcError(null, -32600, 'Invalid Request') };
  }
  const req = parsed as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  // Notifications carry no id: answer 202 with no body.
  if (req.id === undefined) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  const ctx: RestCtx = { store };
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: jsonRpc(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          protocolVersion: '2026-07-28',
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return {
        status: 200,
        body: jsonRpc(id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: SERVER_INFO }),
      };
    }
    case 'tools/list':
      return {
        status: 200,
        body: jsonRpc(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: 'object', properties: t.properties, required: t.required },
          })),
        }),
      };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return { status: 200, body: jsonRpcError(id, -32602, `Unknown tool: ${name}`) };
      const missing = missingArgs(tool, args);
      if (missing.length > 0) {
        return { status: 200, body: jsonRpcError(id, -32602, `Missing required argument: ${missing.join(', ')}`) };
      }
      const result = callTool(ctx, tool.name, args);
      return { status: 200, body: jsonRpc(id, result) };
    }
    case 'ping':
      return { status: 200, body: jsonRpc(id, {}) };
    default:
      return { status: 200, body: jsonRpcError(id, -32601, `Method not found: ${method}`) };
  }
}

function callTool(ctx: RestCtx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');
  switch (name) {
    case 'create_repo': {
      const existing = ctx.store.get(VIEWER.login, repoName);
      if (existing) return toolResult(repoJson(existing));
      const repo = ctx.store.create(VIEWER.login, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = ctx.store.get(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const res = createIssue(ctx, owner, repoName, { title: args.title, body: args.body });
      if (res.status !== 201) return toolError(`Could not create issue: ${JSON.stringify(res.body)}`);
      return toolResult(res.body);
    }
    case 'list_issues': {
      const q = new URLSearchParams();
      q.set('state', typeof args.state === 'string' ? args.state : 'open');
      q.set('per_page', '100');
      const res = listIssues(ctx, owner, repoName, q);
      if (res.status !== 200) return toolError(`Could not list issues: ${JSON.stringify(res.body)}`);
      return toolResult(res.body);
    }
    case 'create_pull_request': {
      const res = createPull(ctx, owner, repoName, { title: args.title, body: args.body, head: args.head, base: args.base });
      if (res.status !== 201) return toolError(`Could not create pull request: ${JSON.stringify(res.body)}`);
      return toolResult(res.body);
    }
    case 'merge_pull_request': {
      const num = Number(args.pull_number);
      const res = mergePull(ctx, owner, repoName, num, { merge_method: 'squash' });
      if (res.status !== 200) return toolError(`Could not merge pull request: ${JSON.stringify(res.body)}`);
      return toolResult(res.body);
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export { getIssue as _getIssue, issueJson as _issueJson, pullJson as _pullJson };
