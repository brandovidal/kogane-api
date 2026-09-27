##@ Users (P23)

.PHONY: superadmin owner user-invite

# Where the invitation links point (the web of each environment); APP_URL=<url> on the command line overrides it
PROD_APP_URL := https://kogane-app.brandovidal.workers.dev
APP_URL ?= $(if $(filter prod,$(ENV)),$(PROD_APP_URL),http://localhost:4000)

superadmin: env-file ## Create or promote a superadmin: EMAIL=<email> [NAME=] [PHONE=] [DNI=] [SEND=yes] [ENV=prod]; prints a link to define a password
	@test -n "$(EMAIL)" || (echo "Usage: make superadmin EMAIL=<email> [NAME=<name>]"; exit 1)
	APP_URL="$(APP_URL)" $(DOTENV) tsx scripts/users.ts superadmin "$(EMAIL)" $(if $(NAME),--name="$(NAME)") $(if $(PHONE),--phone="$(PHONE)") $(if $(DNI),--dni="$(DNI)") $(if $(filter yes,$(SEND)),--send)

owner: env-file ## The data that existed before P23 belongs to this email: EMAIL=<email> [NAME=] [ROLE=admin|member, default admin] [PHONE=] [DNI=] [ENV=prod]
	@test -n "$(EMAIL)" || (echo "Usage: make owner EMAIL=<email> [NAME=<name>]"; exit 1)
	APP_URL="$(APP_URL)" $(DOTENV) tsx scripts/users.ts owner "$(EMAIL)" $(if $(NAME),--name="$(NAME)") $(if $(ROLE),--role=$(ROLE)) $(if $(PHONE),--phone="$(PHONE)") $(if $(DNI),--dni="$(DNI)") $(if $(filter yes,$(SEND)),--send)

user-invite: env-file ## An invitation link (7 days) for an email: EMAIL=<email> [ROLE=admin|member] [SEND=yes] [ENV=prod]
	@test -n "$(EMAIL)" || (echo "Usage: make user-invite EMAIL=<email> [ROLE=admin|member]"; exit 1)
	APP_URL="$(APP_URL)" $(DOTENV) tsx scripts/users.ts invite "$(EMAIL)" --role=$(or $(ROLE),member) $(if $(filter yes,$(SEND)),--send)
