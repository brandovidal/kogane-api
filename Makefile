# kogane-api tasks, grouped in makefiles/*.mk (run `make help`).
# ENV=dev (.env.dev, SQLite dev.db, default), ENV=qa (.env.qa, Turso kogane-db-dev: kogane-api-dev on Railway)
# or ENV=prod (.env.prod, Turso kogane-db: production).
# Compatible with GNU Make 3.81 (macOS). package.json keeps only what CI, husky and Railway call.
ENV ?= dev
ENV_FILE := .env.$(ENV)
DOTENV := pnpm exec dotenv -e $(ENV_FILE) --
DOTENV_DEV := pnpm exec dotenv -e .env.dev
DOTENV_TEST := pnpm exec dotenv -e .env.test

.DEFAULT_GOAL := help
.PHONY: help env-file

##@ General

help: ## Show the available tasks by group
	@awk 'BEGIN {FS = ":.*## "} \
	  /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)} \
	  /^[a-zA-Z_\\:-]+:.*## / {name = $$0; gsub(/\\:/, "\001", name); sub(/:.*/, "", name); gsub(/\001/, ":", name); \
	    printf "  \033[36m%-18s\033[0m %s\n", name, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "  ENV=dev (default, .env.dev, SQLite) | ENV=qa (.env.qa, Turso kogane-db-dev) | ENV=prod (.env.prod, Turso kogane-db: production)"

env-file:
	@test -f $(ENV_FILE) || (echo "Missing $(ENV_FILE): copy .env.example"; exit 1)

include makefiles/app.mk makefiles/db.mk makefiles/bot.mk makefiles/quality.mk makefiles/eval.mk makefiles/recognition.mk makefiles/docker.mk makefiles/notifications.mk makefiles/import.mk makefiles/users.mk
