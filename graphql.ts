// GitHub GraphQL v4: a hand-rolled parser + executor for exactly the documents
// gh and github-mcp-server send. No GraphQL library; stdlib only.

import { squashMerge } from './git.ts';
import {
  commentGid,
  diffTrees,
  issueGid,
  mergeBase,
  parseCommit,
  pullGid,
  repoGid,
  threeWayMerge,
  ungid,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
      if (c === '#') while (i < src.length && src[i] !== '\n') i++;
      else i++;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e === '/' ? '/' : e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      tokens.push({ kind: raw.includes('.') || raw.includes('e') || raw.includes('E') ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  operation: 'query' | 'mutation';
  name: string;
  variables: string[];
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos++;
    return t;
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t;
  }

  parseDocument(): Operation {
    const opTok = this.next();
    if (opTok.kind !== 'name' || (opTok.value !== 'query' && opTok.value !== 'mutation')) {
      throw new Error(`expected query or mutation, got ${opTok.value}`);
    }
    const nameTok = this.next();
    const name = nameTok.value;
    const variables: string[] = [];
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() && this.peek()!.value !== ')') {
        const v = this.next();
        if (v.kind === 'punct' && v.value === '$') {
          const vn = this.next();
          variables.push(vn.value);
        }
        // skip the type tokens until ',' or ')' — types are not needed
        let depth = 0;
        while (this.peek()) {
          const t = this.peek()!;
          if (t.value === '(' || t.value === '[') depth++;
          else if (t.value === ')' || t.value === ']') {
            if (depth === 0) break;
            depth--;
          } else if (t.value === ',' && depth === 0) {
            this.next();
            break;
          }
          if (t.value === ')' && depth === 0) break;
          this.next();
        }
      }
      this.expect(')');
    }
    const selection = this.parseSelectionSet();
    return { operation: opTok.value as 'query' | 'mutation', name, variables, selection };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() && this.peek()!.value !== '}') {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  parseSelection(): SelectionNode {
    const t = this.peek()!;
    if (t.kind === 'spread') {
      this.next();
      const on = this.next();
      if (on.value !== 'on') throw new Error('expected "on" in fragment');
      const typeTok = this.next();
      return { kind: 'fragment', typeCondition: typeTok.value, selection: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let nameTok = this.next();
    if (this.peek()?.value === ':') {
      this.next();
      alias = nameTok.value;
      nameTok = this.next();
    }
    const name = nameTok.value;
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() && this.peek()!.value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek()?.value === ',') this.next();
      }
      this.expect(')');
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek() && this.peek()!.value !== ']') {
        values.push(this.parseValue());
        if (this.peek()?.value === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() && this.peek()!.value !== '}') {
        const fname = this.next().value;
        this.expect(':');
        fields.push({ name: fname, value: this.parseValue() });
        if (this.peek()?.value === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema (for validation + introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  __Type: ['fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION'],
};

// ---------------------------------------------------------------- execution

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

function err(message: string): Error {
  const e = new Error(message);
  (e as { gql?: boolean }).gql = true;
  return e;
}

export class GraphQLExecutor {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  execute(query: string, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
    let op: Operation;
    try {
      op = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    try {
      this.validate(op.operation === 'query' ? 'Query' : 'Mutation', op.selection);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    try {
      const data = this.executeSelection(op.operation === 'query' ? 'Query' : 'Mutation', null, op.selection, variables);
      return { data };
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  }

  private validate(typeName: string, selection: SelectionNode[]): void {
    for (const sel of selection) {
      if (sel.kind === 'fragment') {
        this.validate(sel.typeCondition, sel.selection);
        continue;
      }
      const fields = TYPE_FIELDS[typeName];
      if (!fields || !fields.includes(sel.name)) {
        throw err(`Cannot query field "${sel.name}" on type "${typeName}".`);
      }
      if (sel.selection) {
        const childType = this.childType(typeName, sel.name);
        if (childType) this.validate(childType, sel.selection);
      }
    }
  }

  private childType(parent: string, field: string): string | null {
    const map: Record<string, Record<string, string>> = {
      Query: { viewer: 'User', repository: 'Repository', node: 'Repository', __type: '__Type' },
      Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
      Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
      IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
      PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
      PullRequest: { files: 'PullRequestChangedFileConnection' },
      PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
      __Type: { fields: '__Field', enumValues: '__EnumValue' },
      CreateIssuePayload: { issue: 'Issue' },
      CloseIssuePayload: { issue: 'Issue' },
      CreatePullRequestPayload: { pullRequest: 'PullRequest' },
      MergePullRequestPayload: { pullRequest: 'PullRequest' },
      AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
      IssueCommentEdge: { node: 'IssueComment' },
    };
    return map[parent]?.[field] ?? null;
  }

  private argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
    return out;
  }

  private executeSelection(typeName: string, parent: GqlObject | null, selection: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind === 'fragment') {
        if (parent === null || parent.__type === sel.typeCondition) {
          Object.assign(out, this.executeSelection(sel.typeCondition, parent, sel.selection, variables));
        }
        continue;
      }
      const key = sel.alias ?? sel.name;
      const args = this.argsOf(sel, variables);
      out[key] = this.resolveField(typeName, parent, sel, args, variables);
    }
    return out;
  }

  private resolveField(typeName: string, parent: GqlObject | null, field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const sub = field.selection;
    const nest = (childType: string, child: GqlObject | null): unknown => {
      if (child === null || child === undefined) return null;
      if (!sub) return child;
      return this.executeSelection(childType, child, sub, variables);
    };
    if (typeName === 'Query') {
      if (field.name === 'viewer') {
        return nest('User', { __type: 'User', login: VIEWER.login });
      }
      if (field.name === 'repository') {
        const repo = this.store.get(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo || repo.owner !== VIEWER.login) return null;
        return nest('Repository', this.repoObject(repo));
      }
      if (field.name === 'node') {
        const decoded = ungid(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = this.store.getById(parseInt(decoded.key, 10));
          if (!repo) return null;
          return nest('Repository', this.repoObject(repo));
        }
        return null;
      }
      if (field.name === '__type') {
        return nest('__Type', { __type: '__Type', typeName: String(args.name ?? '') });
      }
    }
    if (typeName === 'Mutation') {
      return this.resolveMutation(field, args, variables);
    }
    if (parent === null) return null;
    switch (typeName) {
      case 'Repository': {
        const repo = parent.__repo as Repo;
        switch (field.name) {
          case 'owner':
            return nest('User', { __type: 'User', login: repo.owner });
          case 'defaultBranchRef': {
            const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
            if (!tip) return null;
            return nest('Ref', { __type: 'Ref', name: repo.defaultBranch });
          }
          case 'issue': {
            const issue = repo.issues.find((i) => i.number === (args.number as number));
            if (!issue) return null;
            return nest('Issue', this.issueObject(repo, issue));
          }
          case 'issues':
            return nest('IssueConnection', this.issuesConnection(repo, args));
          case 'pullRequests':
            return nest('PullRequestConnection', this.pullsConnection(repo, args));
          case 'pullRequest': {
            const pull = repo.pulls.find((p) => p.number === (args.number as number));
            if (!pull) return null;
            return nest('PullRequest', this.pullObject(repo, pull));
          }
          default:
            return parent[field.name] ?? null;
        }
      }
      case 'IssueConnection':
      case 'PullRequestConnection': {
        if (field.name === 'nodes') {
          const nodes = (parent.__nodes as GqlObject[]) ?? [];
          return nodes.map((n) => {
            const t = n.__type;
            return this.executeSelection(t, n, sub ?? [], variables);
          });
        }
        if (field.name === 'pageInfo') {
          return nest('PageInfo', parent.__pageInfo as GqlObject);
        }
        return null;
      }
      case 'PullRequest': {
        const repo = parent.__repo as Repo;
        const pull = parent.__pull as Pull;
        if (field.name === 'files') {
          return nest('PullRequestChangedFileConnection', this.pullFilesConnection(repo, pull, args));
        }
        return parent[field.name] ?? null;
      }
      case 'PullRequestChangedFileConnection': {
        if (field.name === 'nodes') {
          const nodes = (parent.__nodes as GqlObject[]) ?? [];
          return nodes.map((n) => this.executeSelection('PullRequestChangedFile', n, sub ?? [], variables));
        }
        return null;
      }
      case '__Type': {
        const typeNameArg = parent.typeName as string;
        if (field.name === 'fields') {
          return (TYPE_FIELDS[typeNameArg] ?? []).map((name) => ({ name }));
        }
        if (field.name === 'enumValues') {
          return (ENUM_VALUES[typeNameArg] ?? []).map((name) => ({ name }));
        }
        return null;
      }
      default:
        return parent[field.name] ?? null;
    }
  }

  private repoObject(repo: Repo): GqlObject {
    return {
      __type: 'Repository',
      __repo: repo,
      id: repoGid(repo),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
    };
  }

  private issueObject(repo: Repo, issue: Issue): GqlObject {
    return {
      __type: 'Issue',
      __repo: repo,
      __issue: issue,
      id: issueGid(repo, issue.number),
      number: issue.number,
      title: issue.title,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      body: issue.body,
    };
  }

  private pullObject(repo: Repo, pull: Pull): GqlObject {
    return {
      __type: 'PullRequest',
      __repo: repo,
      __pull: pull,
      id: pullGid(repo, pull.number),
      number: pull.number,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pull.merged,
      headRefName: pull.head,
      baseRefName: pull.base,
      mergeable: computeMergeable(repo, pull),
    };
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    let issues = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (states && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      issues = issues.filter((i) => wanted.has(i.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const desc = !orderBy || (orderBy.direction ?? 'DESC') === 'DESC';
    issues.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const after = args.after as string | null | undefined;
    let start = 0;
    if (after) {
      const decoded = decodeCursor(after);
      if (decoded !== null) {
        const idx = issues.findIndex((i) => i.number === decoded);
        if (idx >= 0) start = idx + 1;
      }
    }
    const slice = issues.slice(start, start + first);
    const hasNextPage = start + slice.length < issues.length;
    const endCursor = slice.length > 0 ? encodeCursor(slice[slice.length - 1].number) : null;
    return {
      __type: 'IssueConnection',
      __nodes: slice.map((i) => this.issueObject(repo, i)),
      __pageInfo: { __type: 'PageInfo', hasNextPage, endCursor },
    };
  }

  private pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
    const slice = repo.pulls.slice(0, first);
    return {
      __type: 'PullRequestConnection',
      __nodes: slice.map((p) => this.pullObject(repo, p)),
      __pageInfo: { __type: 'PageInfo', hasNextPage: slice.length < repo.pulls.length, endCursor: null },
    };
  }

  private pullFilesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObject {
    const first = typeof args.first === 'number' ? args.first : 100;
    const headOid = repo.refs.get(`refs/heads/${pull.head}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
    const nodes: GqlObject[] = [];
    if (headOid && baseOid) {
      const mb = mergeBase(repo, headOid, baseOid);
      const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : null;
      const headTree = parseCommit(repo.objects.get(headOid)!.data).tree;
      const diff = diffTrees(repo, mbTree, headTree);
      for (const d of diff.slice(0, first)) {
        nodes.push({ __type: 'PullRequestChangedFile', path: d.path });
      }
    }
    return { __type: 'PullRequestChangedFileConnection', __nodes: nodes };
  }

  private resolveMutation(field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const sub = field.selection ?? [];
    const input = (args.input ?? {}) as Record<string, unknown>;
    const nest = (type: string, obj: GqlObject | null): unknown => {
      if (obj === null) return null;
      return this.executeSelection(type, obj, sub, variables);
    };
    if (field.name === 'createIssue') {
      const decoded = ungid(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'Repository') throw err('Unknown repository');
      const repo = this.store.getById(parseInt(decoded.key, 10));
      if (!repo) throw err('Unknown repository');
      const issue: Issue = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
      };
      repo.issues.push(issue);
      repo.cache.clear();
      return nest('CreateIssuePayload', { __type: 'CreateIssuePayload', issue: this.issueObject(repo, issue) });
    }
    if (field.name === 'closeIssue') {
      const decoded = ungid(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw err('Unknown issue');
      const [repoId, num] = decoded.key.split(':');
      const repo = this.store.getById(parseInt(repoId, 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(num, 10));
      if (!issue) throw err('Unknown issue');
      issue.state = 'closed';
      repo!.cache.clear();
      return nest('CloseIssuePayload', { __type: 'CloseIssuePayload', issue: this.issueObject(repo!, issue) });
    }
    if (field.name === 'createPullRequest') {
      const decoded = ungid(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'Repository') throw err('Unknown repository');
      const repo = this.store.getById(parseInt(decoded.key, 10));
      if (!repo) throw err('Unknown repository');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!repo.refs.get(`refs/heads/${head}`) || !repo.refs.get(`refs/heads/${base}`)) throw err('Unknown branch');
      const pull: Pull = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
      };
      repo.pulls.push(pull);
      repo.cache.clear();
      return nest('CreatePullRequestPayload', { __type: 'CreatePullRequestPayload', pullRequest: this.pullObject(repo, pull) });
    }
    if (field.name === 'mergePullRequest') {
      const decoded = ungid(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PullRequest') throw err('Unknown pull request');
      const [repoId, num] = decoded.key.split(':');
      const repo = this.store.getById(parseInt(repoId, 10));
      const pull = repo?.pulls.find((p) => p.number === parseInt(num, 10));
      if (!pull || !repo) throw err('Unknown pull request');
      const result = squashMerge(this.store, repo, pull.head, pull.base);
      if (!result.ok) throw err(result.reason ?? 'Cannot merge');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = '2025-01-01T00:00:00Z';
      pull.mergeCommitSha = result.mergeCommit ?? null;
      repo.cache.clear();
      return nest('MergePullRequestPayload', { __type: 'MergePullRequestPayload', pullRequest: this.pullObject(repo, pull) });
    }
    if (field.name === 'addComment') {
      const decoded = ungid(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw err('Unknown subject');
      const [repoId, num] = decoded.key.split(':');
      const repo = this.store.getById(parseInt(repoId, 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(num, 10));
      if (!issue || !repo) throw err('Unknown issue');
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? '') };
      issue.comments.push(comment);
      repo.cache.clear();
      const node: GqlObject = { __type: 'IssueComment', id: commentGid(repo, issue.number, comment.id), body: comment.body };
      return nest('AddCommentPayload', { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node } });
    }
    throw err(`Unknown mutation ${field.name}`);
  }
}

function computeMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
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

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}
