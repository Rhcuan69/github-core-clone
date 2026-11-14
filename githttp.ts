// git smart-HTTP handlers: info/refs, git-upload-pack (v0/v2), git-receive-pack.

import {
  V0_RECEIVE_CAPS,
  V0_UPLOAD_CAPS,
  V2_CAPS,
  decodePkts,
  encodePkts,
  headTarget,
  parseTagTarget,
  pktLine,
  readPack,
  selectFetchObjects,
  sortedRefs,
  splitCommands,
  squashMerge,
  v0RefLines,
  writePack,
  type FetchSelection,
} from './git.ts';
import { ZERO_OID, ancestors, parseCommit, type Repo, type Store } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

/** Pack cache: identical fetch requests on the same repo content give identical packs. */
const packCache = new WeakMap<Repo, Map<string, Buffer>>();

export function clearPackCache(repo: Repo): void {
  packCache.delete(repo);
}

function cachedPack(repo: Repo, key: string, build: () => Buffer): Buffer {
  let map = packCache.get(repo);
  if (!map) {
    map = new Map();
    packCache.set(repo, map);
  }
  const hit = map.get(key);
  if (hit) return hit;
  const pack = build();
  if (map.size > 64) map.clear();
  map.set(key, pack);
  return pack;
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(repo: Repo, service: string, gitProtocol: string): GitResponse {
  if (service === 'git-receive-pack') {
    const lines = ['# service=git-receive-pack\n', 'flush', ...v0RefLines(repo, V0_RECEIVE_CAPS)];
    return ok(RECEIVE_AD_CT, encodePkts([...lines, 'flush']));
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol.includes('version=2')) {
      const lines = ['# service=git-upload-pack\n', 'flush', 'version 2\n', ...V2_CAPS.map((c) => `${c}\n`)];
      return ok(UPLOAD_AD_CT, encodePkts([...lines, 'flush']));
    }
    const lines = ['# service=git-upload-pack\n', 'flush', ...v0RefLines(repo, V0_UPLOAD_CAPS)];
    return ok(UPLOAD_AD_CT, encodePkts([...lines, 'flush']));
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
}

function parseV2Args(packets: Array<{ kind: string; payload: Buffer }>): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (command === '') {
      command = line;
      continue;
    }
    // The only capability lines a client sends are object-format, agent and
    // server-option; every other line is a command argument, whether or not
    // a delim packet separates them (fetch sends arguments after the delim,
    // ls-refs sends them directly).
    if (/^(object-format|agent|server-option)(=| |$)/.test(line)) continue;
    args.push(line);
  }
  return { command, args };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += 65515) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 65515)])));
  }
  return out;
}

function handleLsRefs(repo: Repo, args: string[]): GitResponse {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const head = headTarget(repo);
  const headOid = repo.refs.get(head);
  if (headOid === undefined) {
    if (unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:${head}\n`);
  } else if (keep('HEAD')) {
    lines.push(symrefs ? `${headOid} HEAD symref-target:${head}\n` : `${headOid} HEAD\n`);
  }
  for (const r of refs) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) {
      const obj = repo.objects.get(r.oid);
      if (obj && obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) line += ` peeled:${target}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return ok(UPLOAD_RESULT_CT, encodePkts([...lines, 'flush']));
}

function handleFetchV2(repo: Repo, args: string[]): GitResponse {
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: true };
  for (const a of args) {
    if (a.startsWith('want ')) fetch.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) fetch.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) fetch.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) fetch.depth = parseInt(a.slice(7).trim(), 10);
    else if (a === 'thin-pack') fetch.thinPack = true;
  }
  const sel: FetchSelection = selectFetchObjects(repo, fetch.wants, fetch.haves, fetch.depth ?? 0, fetch.shallow);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client sent haves.
  if (fetch.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let allHeld = true;
    for (const h of fetch.haves) {
      if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
      else allHeld = false;
    }
    if (!allHeld) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (sel.objects.size > 0) {
    const key = `v2|${fetch.wants.join(',')}|${fetch.haves.join(',')}|${fetch.depth ?? 0}|${fetch.shallow.join(',')}`;
    const pack = cachedPack(repo, key, () => writePack(sel.objects));
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return ok(UPLOAD_RESULT_CT, Buffer.concat(parts));
}

function handleFetchV0(repo: Repo, body: Buffer): GitResponse {
  const { packets } = splitCommands(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const sel: FetchSelection = selectFetchObjects(repo, wants, haves, depth ?? 0, shallow);
  const parts: Buffer[] = [];
  let allHeld = true;
  for (const h of haves) {
    if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
    else allHeld = false;
  }
  if (haves.length === 0 || !allHeld) parts.push(pktLine('NAK\n'));
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (sel.objects.size > 0) {
    const key = `v0|${wants.join(',')}|${haves.join(',')}|${depth ?? 0}|${shallow.join(',')}`;
    const pack = cachedPack(repo, key, () => writePack(sel.objects));
    parts.push(...sidebandPack(pack));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return ok(UPLOAD_RESULT_CT, Buffer.concat(parts));
}

export function handleUploadPack(repo: Repo, body: Buffer, gitProtocol: string): GitResponse {
  let packets;
  try {
    packets = decodePkts(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n') };
  }
  if (gitProtocol.includes('version=2')) {
    const { command, args } = parseV2Args(packets);
    if (command === 'command=ls-refs') return handleLsRefs(repo, args);
    if (command === 'command=fetch') return handleFetchV2(repo, args);
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n') };
  }
  return handleFetchV0(repo, body);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  let commands: PushCommand[] = [];
  let packBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let sideband = false;
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    const { packets, rest } = splitCommands(body);
    packBytes = rest;
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      let line = p.payload.toString('utf8');
      const nul = line.indexOf('\0');
      let caps = '';
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      if (caps.includes('side-band-64k')) sideband = true;
      const parts = line.replace(/\n$/, '').split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n') };
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, repo);
      for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  } else if (commands.some((c) => c.newOid !== ZERO_OID)) {
    unpackOk = false;
    unpackDetail = 'unpack error: no pack';
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
        else if (current !== cmd.oldOid) results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
        else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        else if (!repo.objects.has(cmd.newOid)) results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
      } else {
        // update: fast-forward required
        if (current === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
        else if (current !== cmd.oldOid) results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
        else if (!repo.objects.has(cmd.newOid)) results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        else if (!ancestors(repo, cmd.newOid).has(cmd.oldOid)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
      }
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: unpackDetail });
  }
  repo.cache.clear();
  clearPackCache(repo);
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  const report = encodePkts(reportLines);
  let bodyOut: Buffer;
  if (sideband) {
    bodyOut = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), Buffer.from('0000', 'ascii')]);
  } else {
    bodyOut = Buffer.concat([report, Buffer.from('0000', 'ascii')]);
  }
  return ok(RECEIVE_RESULT_CT, bodyOut);
}

export { parseCommit as _parseCommit };
