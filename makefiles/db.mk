##@ Database

.PHONY: deps generate db-deploy db-reset migrate audit-triggers seed studio

deps: env-file generate db-deploy seed ## After a pull: Prisma client, pending migrations, catalogs, bot command menu and (dev) local Redis
	@if [ "$(ENV)" = "dev" ]; then ./scripts/redis.sh || echo "Redis not started: reminders are off"; fi
	@if grep -Eq '^TELEGRAM_BOT_TOKEN=.+' $(ENV_FILE); then \
	  $(DOTENV) tsx scripts/telegram-setup.ts --optional-webhook; \
	else echo "TELEGRAM_BOT_TOKEN not set in $(ENV_FILE): bot menu skipped"; fi
	@echo "✔ $(ENV) ready"

generate: ## Generate the Prisma client (pnpm install does not: ignore-scripts=true)
	pnpm exec prisma generate

# Prisma Migrate cannot talk to remote Turso: scripts/db-deploy.ts applies the same SQL files there
db-deploy: env-file ## Apply pending migrations (SQLite: prisma migrate deploy, Turso: scripts/db-deploy.ts)
	@if grep -Eq '^DATABASE_URL="?file:' $(ENV_FILE); then \
	  $(DOTENV) prisma migrate deploy; \
	else $(DOTENV) tsx scripts/db-deploy.ts; fi

# Clean data in dev: every table emptied (schema and migrations stay) and the catalogs loaded again. Never in prod
db-reset: env-file ## Empty EVERY table of the dev database and reload the catalogs; asks to type "dev" (or CONFIRM=yes). Only ENV=dev
	@test "$(ENV)" = "dev" || (echo "db-reset solo corre en ENV=dev: la base de producción nunca se vacía"; exit 1)
	@if [ "$(CONFIRM)" != "yes" ]; then \
	  db=$$(grep -E '^DATABASE_URL=' $(ENV_FILE) | cut -d= -f2- | tr -d '"' | cut -d'?' -f1); \
	  printf "Se borran TODOS los datos de %s (gastos, deudas, borradores, importaciones…).\nEscribe dev para confirmar: " "$$db"; \
	  read answer; \
	  if [ "$$answer" != "dev" ]; then echo "Cancelado: no se borró nada."; exit 1; fi; \
	fi
	$(DOTENV) tsx scripts/db-reset.ts $(ENV)
	@$(MAKE) --no-print-directory seed ENV=$(ENV)

migrate: ## New migration on the local dev.db + client (NAME=add_something)
	@test -n "$(NAME)" || (echo "Usage: make migrate NAME=<migration_name>"; exit 1)
	$(DOTENV_DEV) -- prisma migrate dev --name $(NAME)
	pnpm exec prisma generate

audit-triggers: env-file ## History triggers (P29): new migration when an audited table changed; CHECK=yes only reports [ENV=dev]
	$(DOTENV) tsx scripts/audit-triggers.ts $(if $(filter yes,$(CHECK)),--check)

seed: env-file ## Load or update catalogs (safe to re-run)
	$(DOTENV) tsx prisma/seed.ts

studio: env-file ## Open Prisma Studio
	$(DOTENV) prisma studio
