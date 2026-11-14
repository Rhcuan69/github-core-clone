// HTTP server: routing, auth, body handling, JSON discipline.
// The forge's one process: git smart HTTP + REST v3 + GraphQL + MCP.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { GraphQLExecutor } from './graphql.ts';
import {
  createIssue,
  createLabel,
  createPull,
  createRef,
  createRepo,
  deleteContents,
  deleteRepo,
  getBranch,
  getContents,
  getIssue,
  getPull,
  getRef,
  getRepo,
  listBranches,
  listComments,
  listIssues,
  listLabels,
  listPullFiles,
  listPulls,
  listUserRepos,
  mergePull,
  patchIssue,
  patchRepo,
  createComment,
  listCommits,
  putContents,
  decodeSeg,
  type RestCtx,
  type RestResult,
} from './rest.ts';
import { Store, VIEWER } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

export interface AppOptions {
  expectedToken: string;
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${++requestCounter}`,
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, extra);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function createApp(store: Store, options: AppOptions): Server {
  const executor = new GraphQLExecutor(store);
  const ctx: RestCtx = { store };
  const expectedToken = options.expectedToken;

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length);
    if (token === '') return false;
    if (expectedToken !== '') return token === expectedToken;
    return true;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const { pathname, query } = pathOf(req);
      try {
        // Health probe: no auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // MCP endpoint.
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            sendBuffer(res, 204, Buffer.alloc(0), JSON_TYPE);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const raw = await readBody(req);
          const out = handleMcp(store, raw);
          sendBuffer(res, out.status, out.body, out.status === 202 ? 'application/json' : JSON_TYPE);
          return;
        }

        // GraphQL endpoint.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
            return;
          }
          const ops = Array.isArray(parsed) ? parsed : [parsed];
          const results = ops.map((op) => {
            const o = (op ?? {}) as { query?: string; variables?: Record<string, unknown> };
            if (typeof o.query !== 'string') return { data: null, errors: [{ message: 'No query provided' }] };
            return executor.execute(o.query, (o.variables ?? {}) as Record<string, unknown>);
          });
          sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
          return;
        }

        // Git smart HTTP.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeSeg(gitMatch[1]);
          const repoName = decodeSeg(gitMatch[2]);
          const action = gitMatch[3];
          if (!OWNER_RE.test(owner) || !OWNER_RE.test(repoName)) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const repo = store.get(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (action === 'info/refs' && method === 'GET') {
            const service = query.get('service') ?? '';
            const out = handleInfoRefs(repo, service, String(req.headers['git-protocol'] ?? ''));
            sendBuffer(res, out.status, out.body, out.contentType);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const out = handleUploadPack(repo, raw, String(req.headers['git-protocol'] ?? ''));
            sendBuffer(res, out.status, out.body, out.contentType);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            const out = handleReceivePack(store, repo, raw);
            sendBuffer(res, out.status, out.body, out.contentType);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const result = await handleRest(ctx, method, pathname, query, req);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const headers = result.headers ?? {};
          if (result.status === 204) {
            sendBuffer(res, 204, Buffer.alloc(0), JSON_TYPE, headers);
            return;
          }
          if (Buffer.isBuffer(result.body)) {
            sendBuffer(res, result.status, result.body, JSON_TYPE, headers);
            return;
          }
          sendJson(res, result.status, result.body ?? {}, headers);
          return;
        }

        // Anything else: GitHub's JSON 404.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // response already gone
        }
      }
    })();
  });
  return server;
}

// ---------------------------------------------------------------- REST router

async function handleRest(
  ctx: RestCtx,
  method: string,
  pathname: string,
  query: URLSearchParams,
  req: IncomingMessage,
): Promise<RestResult | null> {
  const segs = pathname.split('/').filter((s) => s !== '').slice(2).map(decodeSeg);
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: Record<string, unknown> = {};
  let bodyRaw: Buffer | null = null;
  if (needsBody) {
    bodyRaw = await readBody(req);
    if (bodyRaw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(bodyRaw.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        else body = {};
      } catch {
        return { status: 400, body: { message: 'Invalid JSON body' } };
      }
    }
  }
  void bodyRaw;

  const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

  // GET /api/v3/ and /api/v3 (root)
  if (segs.length === 0) {
    if (method !== 'GET') return null;
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segs[0] === 'meta' && segs.length === 1) {
    if (method !== 'GET') return null;
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (segs[0] === 'user') {
    if (segs.length === 1 && method === 'GET') {
      return {
        status: 200,
        body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' },
      };
    }
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'POST') return createRepo(ctx, body);
      if (method === 'GET') return listUserRepos(ctx, query, baseUrl);
      return null;
    }
    return null;
  }
  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1];
    const repoName = segs[2];
    const rest = segs.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return getRepo(ctx, owner, repoName);
      if (method === 'PATCH') return patchRepo(ctx, owner, repoName, body);
      if (method === 'DELETE') return deleteRepo(ctx, owner, repoName);
      return null;
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') return listBranches(ctx, owner, repoName);
      if (rest.length >= 2 && method === 'GET') return getBranch(ctx, owner, repoName, rest.slice(1).join('/'));
      return null;
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') return createRef(ctx, owner, repoName, body);
      if (rest.length >= 3 && method === 'GET') return getRef(ctx, owner, repoName, rest.slice(2).join('/'));
      return null;
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      return listCommits(ctx, owner, repoName, query);
    }
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') return getContents(ctx, owner, repoName, path, query);
      if (method === 'PUT') return putContents(ctx, owner, repoName, path, body);
      if (method === 'DELETE') return deleteContents(ctx, owner, repoName, path, body);
      return null;
    }
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') return createLabel(ctx, owner, repoName, body);
      if (rest.length === 1 && method === 'GET') return listLabels(ctx, owner, repoName);
      return null;
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') return listIssues(ctx, owner, repoName, query);
        if (method === 'POST') return createIssue(ctx, owner, repoName, body);
        return null;
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return null;
      if (rest.length === 2) {
        if (method === 'GET') return getIssue(ctx, owner, repoName, num);
        if (method === 'PATCH') return patchIssue(ctx, owner, repoName, num, body);
        return null;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') return listComments(ctx, owner, repoName, num);
        if (method === 'POST') return createComment(ctx, owner, repoName, num, body);
        return null;
      }
      return null;
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') return listPulls(ctx, owner, repoName, query);
        if (method === 'POST') return createPull(ctx, owner, repoName, body);
        return null;
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return null;
      if (rest.length === 2 && method === 'GET') return getPull(ctx, owner, repoName, num);
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return listPullFiles(ctx, owner, repoName, num);
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(ctx, owner, repoName, num, body);
      return null;
    }
    return null;
  }
  return null;
}
