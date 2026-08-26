# Validate

Purpose: prove the package compiles, contracts included.

## Do
Run from the engine repository:

```sh
node -e "import('./src/authoring/parser.ts').then(async (m) => { const root = (process.env.PI_CODING_AGENT_DIR || process.env.HOME + '/.pi/agent') + '/workflows'; const r = await m.discoverWorkflows(root); console.log(r.diagnostics.length ? r.diagnostics : 'all workflows valid'); })"
```

WHEN `PI_CODING_AGENT_DIR` is set, the check resolves under `$PI_CODING_AGENT_DIR/workflows`.

The check compiles every discovered contract schema and rejects unsupported
keywords, so a schema error surfaces here rather than at run time.

Fix every reported diagnostic. Do not report success while any diagnostic remains.

## Done when
- diagnostics-clean: the check prints `all workflows valid`.
