# Entorno QA

`ENV=qa` usa `.env.qa`: Turso `kogane-db-dev`, servicio `kogane-api-dev` en Railway (rama `dev`) y web `https://qa-kogane-app.brandovidal.workers.dev`. No hay `make qa`: cualquier comando acepta `ENV=qa` (`make help` los lista).

## Preparar el entorno

```bash
make deps ENV=qa        # Prisma client + migraciones pendientes en Turso + seed + menú del bot
make db-deploy ENV=qa   # solo migraciones
make seed ENV=qa        # solo catálogos
make studio ENV=qa      # Prisma Studio contra kogane-db-dev
```

## Usuarios

Cada comando imprime un enlace de 7 días para definir la contraseña (con Google basta entrar con ese correo). `SEND=yes` además lo envía por correo.

```bash
make owner EMAIL=brandovidaldeza@gmail.com NAME="Brando Vidal" ROLE=admin ENV=qa   # dueño de los datos de legacy-owner
make superadmin EMAIL=yisusdracon@gmail.com PHONE=930764207 ENV=qa               # superadmin con su propio «Yo»
make user-invite EMAIL=<correo> ROLE=member ENV=qa                               # invitación (admin|member)
```

Sin terminal (requiere `ADMIN_BOOTSTRAP_KEY` en Railway):

```bash
curl -X POST <url-api>/v1/admin/superadmins \
  -H "x-admin-key: <ADMIN_BOOTSTRAP_KEY>" -H "Content-Type: application/json" \
  -d '{"email":"yisusdracon@gmail.com","phone":"930764207"}'
```

`401 INVALID_CREDENTIALS` en el login: el usuario no existe en `auth_users` o aún no definió su contraseña.

## Variables en Railway (`kogane-api-dev`)

Los `.env.*` no entran en la imagen (`.dockerignore`): todo va en *Variables* del servicio.

| Variable | Valor |
| --- | --- |
| `STORAGE_ENV` | `qa` (carpeta `qa/` del bucket `kogane`) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | las de `.env.qa` |
| `NODE_ENV` | `production` recomendado: con `dev` las cookies salen sin `secure` y los errores incluyen el stack |
| `APP_URL` | `https://qa-kogane-app.brandovidal.workers.dev` |

## Errores al arrancar

- `STORAGE_ENV must be dev, qa, prod or test`: falta `STORAGE_ENV` en Railway o tiene otro valor.
- `unable to determine transport target for "pino-pretty"`: el deploy no tiene el arreglo del logger (`src/providers/logger/logger.module.ts`) o `NODE_ENV=dev`; `pino-pretty` no está en la imagen.
