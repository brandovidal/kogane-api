# kogane-api

Backend for [kogane-app](../kogane-app): receives expenses from chat (Telegram, then WhatsApp), extracts them with AI and exposes a REST API.

Stack: NestJS 11 · TypeScript · pnpm · Prisma 7 · Turso (libSQL) · Zod 4 · Vitest.

## Setup

```sh
fnm use            # Node 22 (.node-version)
pnpm install
cp .env.example .env.dev
make deps          # Prisma client + pending migrations + catalogs + bot command menu
pnpm dev           # (or make dev) http://localhost:5560/v1/health · Swagger at /docs
```

## Environments

| Env file | Database | Used by |
|---|---|---|
| `.env.dev` | local SQLite `file:./dev.db` | `pnpm dev` and every `make` task by default (`ENV=dev`) |
| `.env.prod` | Turso `kogane-db` (**production**) `libsql://…` + `DATABASE_AUTH_TOKEN` | `make <task> ENV=prod` (GitHub Actions uses the same values as secrets) |
| `.env.test` | local SQLite `file:./test.db` | integration tests |

Env files are git-ignored; never commit tokens.

## Tasks (`make help`)

| Task | Description |
|---|---|
| `make deps [ENV=prod]` | Leave local / Turso ready after pulling: Prisma client, pending table migrations, catalogs, bot command menu (and webhook if `PUBLIC_URL` is set). Safe to re-run |
| `make dev [ENV=prod]` | Start in watch mode |
| `make migrate NAME=<name>` | New migration against local SQLite + regenerate the client |
| `make db-deploy` · `make seed` · `make studio` | Pending migrations · catalogs · Prisma Studio (`ENV=prod` for Turso) |
| `make telegram URL=https://…` | Register the Telegram webhook and command menu |
| `make lint` · `make format` · `make build` | ESLint · Prettier · compile to `dist/` |
| `make test` · `make test-integration` · `make check` | Unit (watch) · integration · everything CI runs |
| `make eval-replay` | Golden set with the recorded AI answers (no AI calls) |
| `make eval-ai CONFIRM=yes [RECORD=1]` | Golden set against the **real AI** (~30 calls of the free daily quota) |

Tasks are grouped in `makefiles/*.mk` (app, database, bot, quality, eval, docker). `package.json` keeps `pnpm dev` (local watch mode) and what Railway (`build`, `start:prod`), CI (`test:ci`, `test:e2e`) and husky (`lint`, `format`) call.

## Deployment

Production: `https://kogane-api.up.railway.app` (Railway + Turso `kogane-db`). Railway deploys `main` by itself (GitHub integration, "Wait for CI"); GitHub Actions runs tests → migrations and seed → Telegram webhook. Local bot: `pnpm dev` + `make tunnel`. Setup, variables, secrets, verification and rollback: [docs/deploy.md](docs/deploy.md). `make docker` runs the production image locally.

## Using the bot (@kogane_finanzas_bot)

Write expenses as you would say them; the bot reads them with AI, asks for what is missing and waits for ✅ Guardar.

| You write | Result |
|---|---|
| `almuerzo 25 soles con yape` | Day-to-day expense (Yape, Comida, today) |
| `uber 18.50 ayer` | Asks "¿Con qué pagaste?" with buttons |
| `zapatillas 300 con io en 3 cuotas` | Credit card expense, installment 1/3, billed by the card closing day |
| `netflix 45 mensual con la oh` · `luz 120 con bcp` · `le presté 100 a dany` | Subscription · fixed cost · receivable |
| `monto 30`, `persona dany`, `cuota 2/6`, `ayer`… | Corrects the expense just read (without AI) |
| 📸 A Yape/Plin screenshot or a voucher photo (caption optional, e.g. `persona dany`) | Reads amount, date, receiver and operation number; warns if the same image or operation was already saved |
| 🎙️ A voice note (up to 60 s) | Transcribes it ("🎙️ Entendí: «…»") and reads it like text |

Buttons: ✅ Guardar · ✏️ Corregir · 📝 Borrador · ❌ Descartar. Commands: `/borrador` (everything pending review: open, kept for later, expired and failed, with ↩️ Retomar), `/ultimos`, `/resumen` (month totals), `/uso` (AI quota used today), `/cancelar`, `/ayuda`.

See [CLAUDE.md](CLAUDE.md) for conventions and the Turso migration flow.
