##@ Reminders (P20)

.PHONY: redis redis-stop notify

# The API of that environment: the local one (dev) or the deployed one (qa, prod: PUBLIC_URL)
ifneq ($(ENV),dev)
NOTIFY_BASE := $$PUBLIC_URL
else
NOTIFY_BASE := http://localhost:$${PORT:-5560}
endif

redis: ## Local Redis for the reminders (Docker, localhost:6379); make dev starts it too
	./scripts/redis.sh

redis-stop: ## Stop the local Redis (its data stays for the next make redis)
	docker stop kogane-redis

notify: env-file ## Run a reminders job now on the running API: JOB=due-reminders|daily-close|weekly|recurring|upcoming-refresh|files-cleanup|collect-month|collect-late [ENV=prod]
	@test -n "$(JOB)" || (echo "Usage: make notify JOB=due-reminders [ENV=prod]"; exit 1)
	@$(DOTENV) sh -c 'curl -fsS -X POST -H "x-api-key: $$API_KEY" "$(NOTIFY_BASE)/v1/notifications/run/$(JOB)"; echo'
