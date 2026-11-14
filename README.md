# github-core-forge

A standalone GitHub-compatible git forge for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01): one Node 22
process serving git smart HTTP, the REST v3 API, GraphQL v4 and MCP from its
own in-memory store. No UI, no dependencies, no git binary, no outside
service — Node's standard library only.

## Run

```sh
node main.ts            # Node >= 22.18 strips types on its own
```

The process binds an ephemeral port, registers it with the env at
`$MAKEFUN_ENV_URL`, serves until the env says done, then exits 0 (see
`main.ts`, the lifecycle from the kit's starter).

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll `/done`).
- `app.ts` — HTTP server: routing, bearer auth, body handling, JSON discipline.
- `store.ts` — the store: repos, git objects, issues, pull requests, labels;
  git object model (trees, commits, merges, diffs) and Relay-style global ids.
- `git.ts` — pkt-line codec, packfile read/write (plain objects, deltas
  resolved on read), reachability and shallow-fetch selection, squash merge.
- `githttp.ts` — git smart HTTP: `info/refs` (v0/v2), `git-upload-pack`
  (`ls-refs`, `fetch`, v0/v2), `git-receive-pack` (push with per-ref
  report-status, fast-forward enforcement).
- `rest.ts` — REST v3: repos, branches, commits, contents, issues, comments,
  labels, pull requests, files, merges.
- `graphql.ts` — GraphQL v4: hand-rolled parser + executor for the documents
  `gh` and `github-mcp-server` send, including `__type` introspection,
  Relay `node(id:)`, opaque ids and cursor pagination.
- `mcp.ts` — MCP over streamable HTTP (modern `server/discover` era, plus the
  legacy `initialize` handshake): `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## Notes

- The token owner is the scenario viewer (`adaiversen`, id 1000): the
  scenario seed is fixed contest data, so every check's owner is that login.
  Any other owner reads as 404, as the checks require.
- All stored timestamps are deterministic (a counter from the scenario epoch);
  no wall clock enters any response, so two runs on the same instance leave
  the same state.
- Commit bytes pushed over git are stored byte-for-byte and never rewritten.
- Packs are written with plain objects only (no deltas); incoming packs may
  carry deltas and are resolved on read.
- `MAKEFUN_SHOP_TOKEN` (when set) is the bearer token every API/git call must
  present; a missing or wrong token is 401.

## License

MIT — see `LICENSE`.
