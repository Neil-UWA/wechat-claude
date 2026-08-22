# Contributing

Thanks for your interest in wechat-claude!

## Development setup

```bash
npm install
npm run build
npm test
```

- Source is TypeScript in `src/`, compiled to `dist/` (gitignored).
- Tests use [vitest](https://vitest.dev): `npm test` (or `npm run test:watch`).
- The daemon and MCP server share logic through small modules
  (`src/sessions.ts`, `src/inbox.ts`, `src/tmux.ts`, etc.) — add behavior
  there so both stay in sync, and cover it with a unit test.

## Conventions

- Strict TypeScript: no `any`, no non-null assertions, explicit return types
  on exported functions.
- User-facing WeChat strings are Chinese by design (the audience is WeChat
  users); keep them in the existing help/reply strings.
- Never build a shell command by string interpolation of user input. Use
  `spawnSync` with an argv array (see `src/tmux.ts`).

## Pull requests

- Keep PRs focused; include tests for new behavior.
- Run `npm run build && npm test` before pushing — CI runs the same.
- Describe user-facing changes so `/help`, the README, and MCP tool
  descriptions can be kept in sync.
