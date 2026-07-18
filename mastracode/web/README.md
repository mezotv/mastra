# mastracode-web

The Mastra Code web surface: API routes (config/fs/GitHub), a deployable Mastra entry (`src/mastra/index.ts`), and the SPA UI. Built on [`@mastra/code-sdk`](../sdk). All agent state (threads, messages, memory, recall vectors) persists in the single app Postgres when `APP_DATABASE_URL` is set.

This is a **standalone pnpm project** (own lockfile, not a monorepo workspace member). For development, the monorepo-provided packages (`@mastra/*`, `mastra`) are consumed via `link:` specs pointing at the monorepo directories, so you always develop against local source. For builds, `scripts/monorepo-deps.mjs` temporarily pins those deps to the exact versions found in the monorepo (see below).

## Setup

```bash
# from the monorepo root
pnpm install

# in mastracode/web
pnpm install
```

## Development

```bash
pnpm web:dev
```

- API server (`mastra dev`) on **:4111**, env loaded/validated by varlock from `.env` against `.env.schema` (package root).
- Vite SPA on **:5173**, proxying `/api`, `/web`, and `/auth/` to the API server.

For the GitHub/sandbox features, start the app database first: `pnpm web:dev:github` (Postgres via docker compose on :54329).

## Build & deploy

```bash
pnpm web:build
```

1. `prebuild` — builds the linked monorepo packages via turbo.
2. Vite builds the SPA to `src/mastra/public/ui/`.
3. `scripts/monorepo-deps.mjs run -- mastra build --dir src/mastra` — pins the `link:` deps to the **exact versions found in the monorepo** (read from each linked package's `package.json`), runs the build, then always restores the `link:` specs (also on failure/Ctrl-C). The build bundles the API server to `.mastra/output/` and copies `public/` (including the SPA) into it automatically.
4. The server serves the SPA same-origin at `/` (see `src/web/spa-static.ts`).

The deploy output's `package.json` therefore pins the exact monorepo versions of `@mastra/*`, so a production deploy `npm install`s them straight from npm — those versions must be published (CI releases alphas). **Known limitation:** until `@mastra/code-sdk` has a proper npm release (changeset queued), the build's final output-deps install step fails on `@mastra/code-sdk@0.0.0`; the bundle, SPA, and output `package.json` are still produced correctly before that step.

To switch the manifest manually: `pnpm deps:pin` / `pnpm deps:link` (the `link:` state is what's committed).

Run the output with `pnpm web:start` (or `node .mastra/output/index.mjs` after installing output deps).

To deploy to Mastra Cloud:

```bash
pnpm web:deploy
```

This runs `web:build` (pinned versions, as above), validates the output (server entry, deploy manifest, SPA), and then `mastra deploy --skip-build`, which uploads the existing `.mastra/output`. Deploy targets `--env production` by default and auto-selects `.env.production` if present — otherwise it will offer to upload vars from the local `.env`, so double-check what you confirm in the prompt. Requires `mastra auth login` first; pass extra flags via `pnpm web:deploy -- --env staging` etc.

## Tests

```bash
pnpm web:test     # server scenario tests (e2e/web)
pnpm web:ui:test  # UI MSW tests (e2e/web-ui)
```

## Workspace skill invocation

The private Web API can activate a user-invocable skill on an existing scoped AgentController session with `POST /web/agent-controller/:controllerId/skills/invoke`. The Web Factory packages workflow skills such as `understand-issue` and `understand-pr` as ordinary, read-only `SKILL.md` files and adds them only to workspaces created by `MastraFactory`; the shared SDK and TUI workspace resolver do not load them. The route resolves every ID through the session workspace, uses the same `<skill name="…">` activation envelope as `/skill/<name>` in the TUI, and returns an error without dispatching when the skill is missing. Authenticated requests may target only the caller's personal session or a Factory worktree owned by that organization user.

## Factory rules

`MastraFactory` accepts one authoritative `rules` tree for Work and Review stage entry and exit, completed tool results, and normalized GitHub events. Construct it with `defaultFactoryRules()` so every deployment policy has an explicit version:

```ts
import { MastraFactory } from './src/web/factory-entry.js';
import { defaultFactoryRules } from './src/web/factory/rules/index.js';

const rules = defaultFactoryRules({
  version: '2026-07-18.1',
  overrides: {
    review: {
      intake: {
        pullRequest: {
          onEnter: context =>
            context.actor.type === 'github' && !context.actor.trusted
              ? { type: 'reject', code: 'forbidden', reason: 'A trusted author is required.' }
              : undefined,
        },
      },
    },
    tools: {
      submit_plan: {
        onResult: () => undefined,
      },
    },
  },
});

const factory = new MastraFactory({ rules });
```

Overrides replace the exact `onEnter`, `onExit`, `onResult`, or `onEvent` leaf; they never compose implicitly with another handler. The version is configuration identity for persisted evaluations and audits, not an event-deduplication key, and Mastra never hashes function source.

Rules are trusted deployment code. They receive normalized, bounded context rather than storage handles, credentials, worktree paths, or raw webhook payloads. Each handler returns one bounded `FactoryRuleDecision` or `void`: a typed rejection, transition, linked-item upsert, skill invocation, bound-session message, or notification. Every returned decision is validated and redacted before persistence; external effects are deferred rather than executed inside rule evaluation.

## GitHub pull request notifications

GitHub project sessions automatically subscribe the current thread after a successful `gh pr create`. The `github_subscribe_pr` tool is primarily for existing pull requests or recovery when automatic subscription did not occur. Use `github_unsubscribe_pr` only to stop notifications early; closing or merging the pull request retires its subscription automatically.

Configure the GitHub App webhook URL as `https://your-host/web/github/webhook`, set `GITHUB_APP_WEBHOOK_SECRET` to the same secret configured in GitHub, and subscribe the App to pull request, pull request review, pull request review comment, and issue comment events. Comments and reviews are delivered only when their author has write access or is an explicitly authorized bot.

## Environment

See `.env.schema` (package root; varlock validates `.env` against it). Minimum: none (runs auth-less, local-only). Auth needs `WORKOS_*`; GitHub needs `GITHUB_APP_*` + auth + `APP_DATABASE_URL`; Railway sandboxes need `RAILWAY_API_TOKEN`. `MASTRACODE_PUBLIC_URL` controls both the WorkOS (`/auth/callback`) and GitHub App (`/auth/github/callback`) redirect URLs.
