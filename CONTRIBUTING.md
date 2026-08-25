# Contributing

Thanks for your interest in wechat-claude!

## Development setup

```bash
git clone https://github.com/Neil-UWA/wechat-claude.git
cd wechat-claude
npm install
npm run build
npm test
```

To run your checkout as the real thing (instead of the published package),
link it and then set up as usual:

```bash
npm link                 # puts the `wechat-claude` bin on your PATH
wechat-claude setup
wechat-claude daemon install
```

- Source is TypeScript in `src/`, compiled to `dist/` (gitignored).
- Files shipped to users live in `templates/` — the `/wechat` slash command
  and the launchd plist template. `.claude/commands/wechat.md` is a symlink
  to `templates/wechat.md`, so edit the template and both stay in sync.
- The CLI (`src/cli.ts`) is the only entry point users have after a global
  install; the `daemon:*` npm scripts just delegate to it. Add new operations
  as CLI subcommands, not as npm scripts.
- Tests use [vitest](https://vitest.dev): `npm test` (or `npm run test:watch`).
- The daemon and MCP server share logic through small modules
  (`src/sessions.ts`, `src/inbox.ts`, `src/tmux.ts`, etc.) — add behavior
  there so both stay in sync, and cover it with a unit test.

## Conventions

- Strict TypeScript: no `any`, no non-null assertions, explicit return types
  on exported functions.
- User-facing WeChat strings live in `src/i18n.ts` with `zh` (default) and
  `en` catalogs — add both when you add a message, and localize content
  markers via `marker()` and relative times via `formatAgo(ms, lang)`.
- Never build a shell command by string interpolation of user input. Use
  `spawnSync` with an argv array (see `src/tmux.ts`).

## Pull requests

- Keep PRs focused; include tests for new behavior.
- Run `npm run build && npm test` before pushing — CI runs the same.
- Describe user-facing changes so `/help`, the README, and MCP tool
  descriptions can be kept in sync.
