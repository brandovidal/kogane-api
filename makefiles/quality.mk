##@ Quality

.PHONY: lint format build knip test test-integration check

lint: ## ESLint
	pnpm lint

format: ## Prettier
	pnpm format

build: ## Compile to dist/
	pnpm build

knip: ## Unused files, exports and dependencies (P28, D121); zero findings or each one justified in knip.jsonc
	pnpm exec knip --no-progress

test: ## Unit tests in watch mode
	$(DOTENV_TEST) -- vitest --project unit

test-integration: ## Integration tests against a fresh SQLite (conversation flows replay recorded AI answers)
	pnpm test:e2e

check: lint build knip ## Lint, build, knip, unit and integration tests (what CI runs)
	pnpm test:ci
	pnpm test:e2e
