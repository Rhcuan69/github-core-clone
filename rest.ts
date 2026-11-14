// GitHub REST v3 surface: repositories, branches, commits, contents, issues,
// comments, labels, pull requests, merges. Shares the store with git/GraphQL/MCP.

import { clearPackCache } from './githttp.ts';
import { squashMerge } from './git.ts';
import {
  ZERO_OID,
  buildCommitText,
  buildTreeFromFiles,
  diffTrees,
  flattenTree,
  identLine,
  mergeBase,
  parseCommit,
  parseTree,
  storeObject,
  threeWayMerge,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestCtx {
  store: Store;
}

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const FIXED_TS = '2025-01-01T00:00:00Z';

export function touch(repo: Repo): void {
  repo.cache.clear();
  clearPackCache(repo);
}

function notFound(message = 'Not Found'): RestResult {
  return { status: 404, body: { message } };
}

function unprocessable(message: string): RestResult {
  return { status: 422, body: { message } };
}

/** Cached JSON bytes for a hot single-object GET; invalidated by touch(). */
function cachedJson(repo: Repo, key: string, build: () => unknown): Buffer {
  const hit = repo.cache.get(key);
  if (hit) return hit;
  const buf = Buffer.from(`${JSON.stringify(build())}\n`, 'utf8');
  repo.cache.set(key, buf);
  return buf;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l ? l.color : 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    comments: issue.comments.length,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeableState(repo, pull),
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  };
}

export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'MERGEABLE';
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headOid || !baseOid) return 'UNKNOWN';
  const mb = mergeBase(repo, headOid, baseOid);
  if (!mb) return 'UNKNOWN';
  const headCommit = parseCommit(repo.objects.get(headOid)!.data);
  const baseCommit = parseCommit(repo.objects.get(baseOid)!.data);
  const mbCommit = parseCommit(repo.objects.get(mb)!.data);
  return threeWayMerge(repo, baseCommit.tree, headCommit.tree, mbCommit.tree).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function parseBranchBody(repo: Repo, branch: string): { tip: string | undefined; files: Map<string, { oid: string; mode: string }> } {
  const tip = branchTip(repo, branch);
  if (!tip) return { tip: undefined, files: new Map() };
  const tree = parseCommit(repo.objects.get(tip)!.data).tree;
  return { tip, files: flattenTree(repo, tree) };
}

/**
 * Commit a file change (create/update/delete) on `branch`. Creates the branch
 * from the default branch when it does not exist yet.
 */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null; created: boolean } {
  const { tip, files } = parseBranchBody(repo, branch);
  const created = !files.has(path);
  let blobOid: string | null = null;
  if (content !== null) {
    blobOid = storeObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
  } else {
    files.delete(path);
  }
  const tree = buildTreeFromFiles(repo, files);
  const ident = identLine(store);
  const commitData = buildCommitText(tree, tip ? [tip] : [], ident, ident, message.endsWith('\n') ? message : `${message}\n`);
  const commitOid = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  touch(repo);
  return { commitOid, blobOid, created };
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

/** Pagination helper: returns the page slice and a Link header value (or ''). */
export function paginate<T>(
  items: T[],
  query: URLSearchParams,
  basePath: string,
  defaultPerPage = 30,
): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '', 10) || defaultPerPage));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link = '';
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${basePath}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`${urlFor(pageNum + 1)}; rel="next"`);
  if (pageNum > 1) parts.push(`${urlFor(pageNum - 1)}; rel="prev"`);
  if (totalPages > 1) {
    parts.push(`${urlFor(1)}; rel="first"`);
    parts.push(`${urlFor(totalPages)}; rel="last"`);
  }
  link = parts.join(', ');
  return { page, link };
}

// ---------------------------------------------------------------- routing helpers

export interface RouteParams {
  owner: string;
  repo: string;
  rest: string[];
}

export function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolve owner/repo: 404 unless the repo exists under the token owner's login. */
export function resolveRepo(ctx: RestCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.get(owner, name) ?? null;
}

// ---------------------------------------------------------------- endpoints

export function createRepo(ctx: RestCtx, body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return { status: 422, body: { message: 'name is required' } };
  if (ctx.store.get(VIEWER.login, name)) {
    return { status: 422, body: { message: 'Repository already exists' } };
  }
  const repo = ctx.store.create(
    VIEWER.login,
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
  );
  return { status: 201, body: repoJson(repo) };
}

export function listUserRepos(ctx: RestCtx, query: URLSearchParams, baseUrl: string): RestResult {
  const repos = ctx.store.ownedBy(VIEWER.login);
  const { page, link } = paginate(repos, query, `${baseUrl}/api/v3/user/repos`);
  const headers: Record<string, string> = {};
  if (link) headers.link = link;
  return { status: 200, body: page.map(repoJson), headers };
}

export function getRepo(ctx: RestCtx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  return { status: 200, body: cachedJson(repo, 'repo', () => repoJson(repo)), headers: { 'content-type': 'application/json; charset=utf-8' } };
}

export function patchRepo(ctx: RestCtx, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  if (typeof body.description === 'string') repo.description = body.description;
  touch(repo);
  return { status: 200, body: repoJson(repo) };
}

export function deleteRepo(ctx: RestCtx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  ctx.store.delete(owner, name);
  return { status: 204 };
}

export function listBranches(ctx: RestCtx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const out: unknown[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  out.sort((a, b) => ((a as { name: string }).name < (b as { name: string }).name ? -1 : 1));
  return { status: 200, body: out };
}

export function getBranch(ctx: RestCtx, owner: string, name: string, branch: string): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const tip = branchTip(repo, branch);
  if (!tip) return notFound('Branch not found');
  return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
}

export function createRef(ctx: RestCtx, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || sha === '') return unprocessable('Invalid ref');
  if (repo.refs.has(ref)) return unprocessable('Reference already exists');
  if (!repo.objects.has(sha)) return unprocessable('Object does not exist');
  repo.refs.set(ref, sha);
  touch(repo);
  return { status: 201, body: { ref, object: { sha } } };
}

export function getRef(ctx: RestCtx, owner: string, name: string, refPath: string): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (!oid) return notFound('Reference not found');
  return { status: 200, body: { ref, object: { sha: oid } } };
}

export function listCommits(ctx: RestCtx, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const branch = query.get('sha') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const out: unknown[] = [];
  if (tip) {
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      const c = parseCommit(obj.data);
      // GitHub's API presents the message without the trailing newline the
      // commit object itself carries.
      out.push({
        sha: oid,
        commit: {
          message: c.message.replace(/\n$/, ''),
          author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS },
          committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS },
        },
      });
      for (const p of c.parents) queue.push(p);
    }
  }
  return { status: 200, body: out };
}

export function putContents(
  ctx: RestCtx,
  owner: string,
  name: string,
  path: string,
  body: Record<string, unknown>,
): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  } catch {
    return { status: 400, body: { message: 'Invalid base64 content' } };
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const { tip, files } = parseBranchBody(repo, branch);
  if (typeof body.sha === 'string' && body.sha !== '') {
    const current = files.get(path);
    if (!current || current.oid.toLowerCase() !== body.sha.toLowerCase()) {
      return { status: 409, body: { message: 'sha does not match the current file' } };
    }
  }
  // Branch does not exist yet: create it from the default branch tip (or unborn).
  let effectiveTip = tip;
  if (effectiveTip === undefined && branch !== repo.defaultBranch) {
    const baseTip = branchTip(repo, repo.defaultBranch);
    if (baseTip) {
      repo.refs.set(`refs/heads/${branch}`, baseTip);
      effectiveTip = baseTip;
    }
  }
  void effectiveTip;
  const { commitOid, blobOid, created } = commitFile(ctx.store, repo, branch, path, content, message);
  return {
    status: created ? 201 : 200,
    body: {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid },
    },
  };
}

export function getContents(
  ctx: RestCtx,
  owner: string,
  name: string,
  path: string,
  query: URLSearchParams,
): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const branch = query.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (!tip) return notFound('Not Found');
  const tree = parseCommit(repo.objects.get(tip)!.data).tree;
  const files = flattenTree(repo, tree);
  if (path === '') {
    // root listing
    const entries = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir'; size?: number }>();
    for (const [p, f] of files) {
      const first = p.split('/')[0];
      if (!p.includes('/')) {
        entries.set(first, { name: first, path: first, sha: f.oid, type: 'file', size: repo.objects.get(f.oid)?.data.length ?? 0 });
      } else if (!entries.has(first)) {
        const dirTree = dirTreeOid(repo, tree, first);
        entries.set(first, { name: first, path: first, sha: dirTree ?? ZERO_OID, type: 'dir' });
      }
    }
    return { status: 200, body: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
  }
  const file = files.get(path);
  if (file) {
    const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: file.oid,
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
      },
    };
  }
  // directory?
  const prefix = `${path}/`;
  const entries: unknown[] = [];
  const seen = new Map<string, unknown>();
  for (const [p, f] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0];
    if (!rest.includes('/')) {
      seen.set(first, { type: 'file', name: first, path: `${path}/${first}`, sha: f.oid, size: repo.objects.get(f.oid)?.data.length ?? 0 });
    } else if (!seen.has(first)) {
      seen.set(first, { type: 'dir', name: first, path: `${path}/${first}`, sha: dirTreeOid(repo, tree, ...path.split('/'), first) ?? ZERO_OID });
    }
  }
  if (seen.size === 0) return notFound('Not Found');
  for (const e of seen.values()) entries.push(e);
  entries.sort((a, b) => ((a as { name: string }).name < (b as { name: string }).name ? -1 : 1));
  return { status: 200, body: entries };
}

function dirTreeOid(repo: Repo, rootTree: string, ...segments: string[]): string | null {
  let oid = rootTree;
  for (const seg of segments) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    let found: string | null = null;
    for (const e of parseTree(obj.data)) {
      if (e.name === seg && e.mode === '40000') found = e.oid;
    }
    if (!found) return null;
    oid = found;
  }
  return oid;
}

export function deleteContents(
  ctx: RestCtx,
  owner: string,
  name: string,
  path: string,
  body: Record<string, unknown>,
): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const { files } = parseBranchBody(repo, branch);
  const current = files.get(path);
  if (!current) return notFound('Not Found');
  if (typeof body.sha === 'string' && body.sha !== '' && current.oid.toLowerCase() !== body.sha.toLowerCase()) {
    return { status: 409, body: { message: 'sha does not match the current file' } };
  }
  const { commitOid } = commitFile(ctx.store, repo, branch, path, null, message);
  return { status: 200, body: { commit: { sha: commitOid } } };
}

export function createLabel(ctx: RestCtx, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const labelName = typeof body.name === 'string' ? body.name : '';
  if (labelName === '') return unprocessable('Label name is required');
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  const existing = repo.labels.get(labelName);
  if (existing) return { status: 200, body: { name: existing.name, color: existing.color } };
  repo.labels.set(labelName, { name: labelName, color });
  touch(repo);
  return { status: 201, body: { name: labelName, color } };
}

export function listLabels(ctx: RestCtx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  return { status: 200, body: [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })) };
}

export function createIssue(ctx: RestCtx, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const title = typeof body.title === 'string' ? body.title : '';
  const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const l of labels) {
    if (!repo.labels.has(l)) return unprocessable(`Label ${l} does not exist`);
  }
  const issue: Issue = {
    number: repo.nextNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    comments: [],
  };
  repo.issues.push(issue);
  touch(repo);
  return { status: 201, body: issueJson(repo, issue) };
}

export function listIssues(ctx: RestCtx, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const state = query.get('state') ?? 'open';
  let issues = repo.issues.filter((i) => state === 'all' || i.state === state);
  const direction = query.get('direction') ?? 'desc';
  issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '', 10) || 1);
  const slice = issues.slice((pageNum - 1) * perPage, pageNum * perPage);
  return { status: 200, body: slice.map((i) => issueJson(repo, i)) };
}

export function getIssue(ctx: RestCtx, owner: string, name: string, number: number): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound('Not Found');
  return { status: 200, body: cachedJson(repo, `issue:${number}`, () => issueJson(repo, issue)) };
}

export function patchIssue(ctx: RestCtx, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound('Not Found');
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  touch(repo);
  return { status: 200, body: issueJson(repo, issue) };
}

export function createComment(ctx: RestCtx, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound('Not Found');
  const comment = { id: repo.nextCommentId++, body: typeof body.body === 'string' ? body.body : '' };
  issue.comments.push(comment);
  touch(repo);
  return { status: 201, body: { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_TS } };
}

export function listComments(ctx: RestCtx, owner: string, name: string, number: number): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound('Not Found');
  return {
    status: 200,
    body: issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_TS })),
  };
}

export function createPull(ctx: RestCtx, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (!branchTip(repo, head) || !branchTip(repo, base)) return unprocessable('Head or base branch does not exist');
  const pull: Pull = {
    number: repo.nextNumber++,
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head,
    base,
  };
  repo.pulls.push(pull);
  touch(repo);
  return { status: 201, body: pullJson(repo, pull) };
}

export function listPulls(ctx: RestCtx, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const state = query.get('state') ?? 'open';
  const pulls = repo.pulls.filter((p) => state === 'all' || p.state === state);
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '', 10) || 1);
  const slice = pulls.slice((pageNum - 1) * perPage, pageNum * perPage);
  return { status: 200, body: slice.map((p) => pullJson(repo, p)) };
}

export function getPull(ctx: RestCtx, owner: string, name: string, number: number): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return notFound('Not Found');
  return { status: 200, body: cachedJson(repo, `pull:${number}`, () => pullJson(repo, pull)) };
}

export function listPullFiles(ctx: RestCtx, owner: string, name: string, number: number): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return notFound('Not Found');
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headOid || !baseOid) return notFound('Not Found');
  const mb = mergeBase(repo, headOid, baseOid);
  const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : null;
  const headTree = parseCommit(repo.objects.get(headOid)!.data).tree;
  const diff = diffTrees(repo, mbTree, headTree);
  const out: unknown[] = [];
  for (const d of diff) {
    const oldBuf = d.oldOid ? repo.objects.get(d.oldOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
    const newBuf = d.newOid ? repo.objects.get(d.newOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
    const additions = d.newOid ? lineCount(newBuf) : 0;
    const deletions = d.oldOid ? lineCount(oldBuf) : 0;
    out.push({
      filename: d.path,
      status: d.status === 'deleted' ? 'removed' : d.status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return { status: 200, body: out };
}

export function mergePull(ctx: RestCtx, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return notFound('Not Found');
  if (pull.merged) return { status: 409, body: { message: 'Pull request already merged' } };
  const method = typeof body.merge_method === 'string' ? body.merge_method.toLowerCase() : 'merge';
  void method; // squash, merge and rebase all land as one squashed commit here
  const result = squashMerge(ctx.store, repo, pull.head, pull.base);
  if (!result.ok) {
    if (result.reason === 'conflict') return { status: 405, body: { message: 'Merge conflict' } };
    return unprocessable(result.reason ?? 'Cannot merge');
  }
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = FIXED_TS;
  pull.mergeCommitSha = result.mergeCommit ?? null;
  touch(repo);
  return { status: 200, body: { merged: true, sha: result.mergeCommit, message: 'Pull request successfully merged' } };
}
