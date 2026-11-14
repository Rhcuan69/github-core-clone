// The forge's store: repositories, git objects, issues, pull requests, labels.
// One process, in-memory only. Deterministic: no wall clock in any stored value
// (commit timestamps come from a counter seeded at the scenario epoch).

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const DEFAULT_BRANCH = 'main';

/** The token owner: the scenario's viewer (wire.ts SCENARIO_SEED is fixed contest data). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  /** Serialized-response cache for the hot read paths; cleared on any mutation. */
  cache: Map<string, Buffer>;
}

export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoId = 5000;
  repoSeq = 0;
  commitSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  get(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  create(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.repoSeq++,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      cache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  delete(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  /** All repos owned by `owner`, in creation order. */
  ownedBy(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Next deterministic commit timestamp (seconds since the scenario epoch). */
  nextCommitTime(): number {
    return SCENARIO_EPOCH_SEC + this.commitSeq++;
  }
}

// ---------------------------------------------------------------- git objects

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitText(tree: string, parents: string[], authorLine: string, committerLine: string, message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${authorLine}\ncommitter ${committerLine}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

export function identLine(store: Store): string {
  const ts = store.nextCommitTime();
  return `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(i, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort: byte-compare names, a directory as if its name ended in '/'. */
export function treeSortKey(name: string, isDir: boolean): string {
  return isDir ? `${name}/` : name;
}

/** Build a tree object (recursively) from a flat path -> {oid, mode} map. Returns the root tree oid. */
export function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    entries.sort((a, b) => {
      const ka = treeSortKey(a.name, a.mode === '40000');
      const kb = treeSortKey(b.name, b.mode === '40000');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return storeObject(repo, 'tree', buildTreeBytes(entries));
  };
  return build(root);
}

/** Flatten a tree object into path -> {oid, mode}. Missing tree -> empty map. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${pre}${e.name}/`);
      else out.set(`${pre}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** All ancestors of `tip` (inclusive), with generation distance from the tip. */
export function ancestors(repo: Repo, tip: string): Map<string, number> {
  const seen = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length) {
    const [oid, gen] = queue.shift()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.set(oid, gen);
    for (const p of parseCommit(obj.data).parents) queue.push([p, gen + 1]);
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestors(repo, descendant).has(ancestor);
}

/** Merge-base: the common ancestor minimizing the max generation distance. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aa = ancestors(repo, a);
  const bb = ancestors(repo, b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, ga] of aa) {
    const gb = bb.get(oid);
    if (gb === undefined) continue;
    const score = Math.max(ga, gb);
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
}

export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): DiffEntry[] {
  const base = baseTree ? flattenTree(repo, baseTree) : new Map();
  const head = headTree ? flattenTree(repo, headTree) : new Map();
  const out: DiffEntry[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'deleted', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

export interface MergeResult {
  conflict: boolean;
  tree: Map<string, { oid: string; mode: string }>;
}

/** Three-way file-level merge. Returns the merged file map and whether it conflicts. */
export function threeWayMerge(repo: Repo, baseTree: string, headTree: string, mergeBaseTree: string): MergeResult {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const mb = flattenTree(repo, mergeBaseTree);
  const out = new Map<string, { oid: string; mode: string }>();
  let conflict = false;
  const paths = new Set([...base.keys(), ...head.keys(), ...mb.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const m = mb.get(path);
    const bOid = b?.oid ?? null;
    const hOid = h?.oid ?? null;
    const mOid = m?.oid ?? null;
    if (bOid === hOid) {
      if (b) out.set(path, b);
    } else if (bOid === mOid) {
      if (h) out.set(path, h);
    } else if (hOid === mOid) {
      if (b) out.set(path, b);
    } else {
      conflict = true;
      if (b) out.set(path, b);
    }
  }
  return { conflict, tree: out };
}

// ---------------------------------------------------------------- global ids (GraphQL Relay-style, opaque)

export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const i = text.indexOf(':');
    if (i < 0) return null;
    return { kind: text.slice(0, i), key: text.slice(i + 1) };
  } catch {
    return null;
  }
}

export function repoGid(repo: Repo): string {
  return gid('Repository', String(repo.id));
}

export function issueGid(repo: Repo, number: number): string {
  return gid('Issue', `${repo.id}:${number}`);
}

export function pullGid(repo: Repo, number: number): string {
  return gid('PullRequest', `${repo.id}:${number}`);
}

export function commentGid(repo: Repo, issueNumber: number, commentId: number): string {
  return gid('IssueComment', `${repo.id}:${issueNumber}:${commentId}`);
}
