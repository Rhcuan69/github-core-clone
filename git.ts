// git smart HTTP: pkt-line codec, packfile read/write, reachability, and the
// upload-pack / receive-pack endpoints. Plain objects only on the wire (no
// deltas generated); deltas in an incoming pack are resolved.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  buildTreeFromFiles,
  hashObject,
  identLine,
  mergeBase,
  parseCommit,
  parseTree,
  storeObject,
  threeWayMerge,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePkts(parts: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    if (p === 'flush') out.push(pktFlush());
    else if (p === 'delim') out.push(pktDelim());
    else out.push(pktLine(p));
  }
  return Buffer.concat(out);
}

/** Decode a whole buffer into packets. Throws on a malformed framing. */
export function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520) throw new Error(`bad pkt-line length ${head}`);
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

/** Split a buffer into pkt-lines plus the trailing raw bytes after the first flush. */
export function splitCommands(buf: Buffer): { packets: Pkt[]; rest: Buffer<ArrayBufferLike> } {
  const packets: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(i + 4) };
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520) throw new Error(`bad pkt-line length ${head}`);
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------- packfile

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodePackEntry(type: ObjType, data: Buffer): Buffer {
  const deflated = deflateSync(data, { level: 1 });
  const header: number[] = [];
  let size = data.length;
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    header.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  header.push(first);
  return Buffer.concat([Buffer.from(header), deflated]);
}

/** Write a v2 pack of plain objects, entries sorted by oid for determinism. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const counts = Buffer.alloc(8);
  counts.writeUInt32BE(2, 0);
  counts.writeUInt32BE(oids.length, 4);
  parts.push(counts);
  for (const oid of oids) {
    const obj = objects.get(oid)!;
    parts.push(encodePackEntry(obj.type, obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++];
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let written = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) offset |= delta[i++] << (8 * b);
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) size |= delta[i++] << (8 * b);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
}

/** Parse a packfile; resolve deltas against the pack itself and `repo` objects. */
export function readPack(buf: Buffer, repo: Repo): ReadPackResult {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expect = createHash('sha1').update(buf.subarray(0, trailerStart)).digest();
  if (!expect.equals(buf.subarray(trailerStart))) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let pos = 12;
  for (let n = 0; n < count; n++) {
    const start = pos;
    let b = buf[pos];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    pos += 1;
    while (b & 0x80) {
      b = buf[pos++];
      size += (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      let v = buf[pos++];
      let value = v & 0x7f;
      while (v & 0x80) {
        v = buf[pos++];
        value = ((value + 1) << 7) + (v & 0x7f);
      }
      const baseOffset = start - value;
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error('ofs-delta base not in pack');
      const { data: delta, next } = inflateAt(buf, pos);
      pos = next;
      const data = applyDelta(base.data, delta);
      const oid = hashObject(base.type, data);
      const obj = { type: base.type, data };
      objects.set(oid, obj);
      byOffset.set(start, obj);
    } else if (typeCode === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data: delta, next } = inflateAt(buf, pos);
      pos = next;
      const baseObj = objects.get(baseOid) ?? repo.objects.get(baseOid);
      if (!baseObj) throw new Error('ref-delta base missing');
      const data = applyDelta(baseObj.data, delta);
      const oid = hashObject(baseObj.type, data);
      const obj = { type: baseObj.type, data };
      objects.set(oid, obj);
      byOffset.set(start, obj);
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`bad pack type ${typeCode}`);
      const { data, next } = inflateAt(buf, pos);
      pos = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, data);
      const obj = { type, data };
      objects.set(oid, obj);
      byOffset.set(start, obj);
    }
  }
  if (pos !== trailerStart) throw new Error('pack has trailing bytes');
  if (objects.size !== count) throw new Error('pack count mismatch');
  return { objects };
}

/**
 * Inflate one zlib stream starting at `pos`; return its bytes and the offset
 * just after it. inflateSync ignores trailing bytes and throws on truncation,
 * so success is monotonic in the slice length: binary-search the smallest
 * length that inflates.
 */
function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  let lo = pos + 1;
  let hi = buf.length;
  let found: Buffer | null = null;
  let foundEnd = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buf.subarray(pos, mid));
      found = data;
      foundEnd = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found === null) throw new Error('corrupt zlib stream in pack');
  return { data: found, next: foundEnd };
}

// ---------------------------------------------------------------- reachability

export interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Objects to send for `wants`, excluding anything reachable from `haves`.
 * depth: 0 = unlimited. shallowBoundaries: oids the client already treats as
 * shallow (their parents are unknown to it).
 */
export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number,
  shallowBoundaries: string[],
): FetchSelection {
  const haveClosure = new Set<string>();
  const shallowSet = new Set(shallowBoundaries);
  for (const h of haves) collectClosure(repo, [h], haveClosure, 0, shallowSet);
  // Generation distance from any want (commits only).
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  const wantCommits = new Set<string>();
  while (queue.length) {
    const [oid, g] = queue.shift()!;
    if (gen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) queue.push([target, g]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    gen.set(oid, g);
    wantCommits.add(oid);
    if (depth === 0 || g + 1 < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push([p, g + 1]);
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth > 0) {
    for (const oid of wantCommits) {
      const g = gen.get(oid)!;
      const obj = repo.objects.get(oid)!;
      const parents = parseCommit(obj.data).parents;
      const cut = g + 1 >= depth && parents.length > 0;
      if (cut) shallow.push(oid);
    }
    for (const b of shallowBoundaries) {
      // A previous boundary is lifted when the commit is now included with all
      // of its parents included too.
      if (gen.has(b)) {
        const obj = repo.objects.get(b);
        if (obj && obj.type === 'commit') {
          const parents = parseCommit(obj.data).parents;
          const allIncluded = parents.every((p) => gen.has(p));
          if (allIncluded && !shallow.includes(b)) unshallow.push(b);
        }
      }
    }
  }
  // Closure of the included commits (trees/blobs) plus wanted non-commit objects.
  const included = new Set<string>();
  for (const oid of wantCommits) {
    if (gen.has(oid)) included.add(oid);
  }
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') included.add(w);
  }
  const objects = new Map<string, GitObject>();
  const addClosure = (oid: string): void => {
    if (objects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (obj.type === 'commit' && !gen.has(oid)) return;
    // A held object is not sent, but its wanted parents still are: traverse
    // through it rather than stopping here.
    const held = haveClosure.has(oid);
    if (!held) objects.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      addClosure(c.tree);
      // parents are only followed when they are in the included set
      for (const p of c.parents) if (gen.has(p)) addClosure(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) addClosure(e.oid);
    } else if (obj.type === 'tag') {
      const t = parseTagTarget(obj.data);
      if (t) addClosure(t);
    }
  };
  for (const oid of [...included]) addClosure(oid);
  // Remove anything the client already holds.
  for (const h of haveClosure) objects.delete(h);
  return { objects, shallow, unshallow };
}

export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m ? m[1] : null;
}

/** Full closure of tips (commits, trees, blobs, tag targets) into `out`. depth 0 = unlimited. */
export function collectClosure(repo: Repo, tips: string[], out: Set<string>, depth: number, stopParents?: Set<string>): void {
  const queue: Array<[string, number]> = tips.map((t) => [t, 0] as [string, number]);
  while (queue.length) {
    const [oid, g] = queue.shift()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push([c.tree, g]);
      // A shallow boundary proves the client holds the commit, not its
      // history: never cross it into the parents.
      if (!stopParents?.has(oid) && (depth === 0 || g + 1 < depth)) for (const p of c.parents) queue.push([p, g + 1]);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push([e.oid, g]);
    } else if (obj.type === 'tag') {
      const t = parseTagTarget(obj.data);
      if (t) queue.push([t, g]);
    }
  }
}

// ---------------------------------------------------------------- refs

export interface RefEntry {
  name: string;
  oid: string;
}

export function sortedRefs(repo: Repo): RefEntry[] {
  const out: RefEntry[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Refs for the v0 advertisement: HEAD first, then sorted refs, with peeled tag lines. */
export function v0RefLines(repo: Repo, caps: string): string[] {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const head = headTarget(repo);
  const headOid = repo.refs.get(head) ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  lines.push(`${headOid} HEAD\0${caps}\n`);
  for (const r of refs) {
    lines.push(`${r.oid} ${r.name}\n`);
    const obj = repo.objects.get(r.oid);
    if (obj && obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) lines.push(`${target} ${r.name}^{}\n`);
    }
  }
  return lines;
}

export const V2_CAPS = ['agent', 'object-format=sha1', 'fetch=shallow', 'ls-refs=unborn'];
export const V0_UPLOAD_CAPS =
  'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent symref=HEAD:refs/heads/main';
export const V0_RECEIVE_CAPS =
  'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent symref=HEAD:refs/heads/main';

// ---------------------------------------------------------------- squash merge (shared by REST, GraphQL, MCP)

export interface SquashResult {
  ok: boolean;
  reason?: string;
  mergeCommit?: string;
}

/** Squash-merge a PR's head onto its base. Returns the merge commit oid. */
export function squashMerge(store: Store, repo: Repo, headRef: string, baseRef: string): SquashResult {
  const headOid = repo.refs.get(`refs/heads/${headRef}`);
  const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headOid || !baseOid) return { ok: false, reason: 'missing branch' };
  const mb = mergeBase(repo, headOid, baseOid);
  if (!mb) return { ok: false, reason: 'no merge base' };
  const headCommit = parseCommit(repo.objects.get(headOid)!.data);
  const baseCommit = parseCommit(repo.objects.get(baseOid)!.data);
  const mbCommit = parseCommit(repo.objects.get(mb)!.data);
  const { conflict, tree } = threeWayMerge(repo, baseCommit.tree, headCommit.tree, mbCommit.tree);
  if (conflict) return { ok: false, reason: 'conflict' };
  const newTree = buildTreeFromFiles(repo, tree);
  const ident = identLine(store);
  const msg = `Squash merge ${headRef} into ${baseRef}\n`;
  const commitData = Buffer.from(
    `tree ${newTree}\nparent ${baseOid}\nauthor ${ident}\ncommitter ${ident}\n\n${msg}`,
    'utf8',
  );
  const commitOid = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${baseRef}`, commitOid);
  repo.cache.clear();
  return { ok: true, mergeCommit: commitOid };
}
