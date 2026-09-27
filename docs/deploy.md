# Despliegue y configuración de kogane-api

kogane-api corre en **Railway**, usa **Turso** (`kogane-db`) como base y el bot de Telegram le manda los mensajes por webhook. Producción: **`https://kogane-api.up.railway.app`**. Railway está conectado al repo y despliega solo cada push a `main`. GitHub Actions (`.github/workflows/deploy.yml`) hace lo que Railway no hace:

```
check (lint, build, tests) → db (migraciones + seed en kogane-db) → telegram (webhook + menú)
```

Con **"Wait for CI"** activado en Railway (Settings → Source), Railway espera a que ese workflow pase antes de desplegar.

Las migraciones corren **antes** que el código nuevo: tienen que funcionar también con la versión anterior (primero agregar, borrar en un deploy posterior).

## Entornos

| Entorno     | Archivo o lugar                                                     | Base                    | Para qué                                                                 |
| ----------- | ------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| local (dev) | `.env.dev`                                                          | SQLite `file:./dev.db`  | `make dev` (API + túnel del bot; `pnpm dev` solo la API), `make deps` |
| producción  | Railway (variables) · GitHub (secretos) · `.env.prod` en tu máquina | Turso `kogane-db`       | La API real; `make <tarea> ENV=prod` para operar a mano                  |
| tests       | `.env.test`                                                         | SQLite `file:./test.db` | `make check` y el CI                                                     |

Los `.env*` no se suben al repo (salvo `.env.example`). Nunca pegues tokens en chats ni issues.

## `PUBLIC_URL` por entorno

Es la URL pública (HTTPS) donde Telegram manda el webhook: `PUBLIC_URL` + `/v1/telegram/webhook`.

| Entorno                                       | Valor                               | Nota                                                                                                 |
| --------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **producción** (Railway, GitHub, `.env.prod`) | `https://kogane-api.up.railway.app` | El dominio que genera Railway. **No** `kogane-api.railway.internal` (red privada): Telegram no llega |
| **local** (`.env.dev`)                        | `http://localhost:5560` o vacío     | Telegram exige HTTPS público: la URL la pone `make tunnel` (cloudflared, cambia en cada arranque)    |
| **tests** (`.env.test`)                       | vacío                               | Los tests no registran webhooks                                                                      |

`make tunnel` abre el túnel, espera a que su URL responda, apunta el webhook del bot de `.env.dev` al túnel (la URL queda en `.tunnel-url` mientras corre) y siempre usa `.env.dev`. Con Ctrl+C, **solo si `.env.dev` y `.env.prod` comparten el token del bot**, devuelve el webhook a producción (`PUBLIC_URL` de `.env.prod`; si falla, avisa que hay que correr `make telegram ENV=prod`); con un bot propio de dev no toca producción. En local, `make telegram` usa `.env.dev`: con el túnel abierto vuelve a registrar el webhook en él; sin túnel solo muestra a dónde apunta el webhook, sin cambiar nada. Si local y producción usan el mismo bot, mientras el túnel está abierto el bot de producción no recibe mensajes. Para evitarlo, crea un segundo bot en @BotFather y pon su token en `.env.dev`.

### Bot propio para dev

1. En Telegram, **@BotFather** → `/newbot` → nombre (p. ej. "Kogane Dev") y usuario terminado en `bot` (p. ej. `kogane_finanzas_dev_bot`). Copia el token.
2. En `.env.dev`: `TELEGRAM_BOT_TOKEN=<token nuevo>`. `TELEGRAM_WEBHOOK_SECRET` puede ser el mismo o uno nuevo (`make secret`).
3. **`TELEGRAM_ALLOWED_CHAT_IDS`:** en un chat privado el `chat_id` es tu id de usuario de Telegram, **el mismo con cualquier bot**. Copia el valor de `.env.prod`. Para verlo desde el bot nuevo (solo funciona mientras no tiene webhook, o sea antes del primer `make tunnel`):
   ```bash
   # escríbele cualquier cosa al bot nuevo y luego:
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'
   ```
   Si ya tiene webhook, `getUpdates` responde 409: bórralo con `curl -s "https://api.telegram.org/bot<TOKEN>/deleteWebhook"` y repite. Otra opción: escribirle a **@userinfobot**, que responde tu id.
4. `make dev` (levanta la API y el túnel juntos; Ctrl+C corta ambos) y escríbele al bot de dev. Por separado: `make dev:only` (o `pnpm dev`) solo la API, y `make tunnel` solo el túnel. `make telegram` (sin `ENV`) muestra a dónde apunta su webhook. Un chat que no está en la lista recibe 200 y se ignora, así que si el bot no responde, revisa este valor primero.
5. **Después de editar `.env.dev`, reinicia la API** (Ctrl+C y `make dev`): `nest start --watch` recarga el código pero lee `.env.dev` solo al arrancar. Si el túnel registró un secret o token nuevo y la API sigue con el viejo, Telegram recibe **401 Unauthorized** y el bot no responde (se ve en `make telegram` como `Last error`).

Secretos (`API_KEY`, `TELEGRAM_WEBHOOK_SECRET`): `make secret` (o `openssl rand -hex 32`); uno distinto por entorno.

## Tareas (`make help`)

El `Makefile` define las variables comunes (`ENV`, archivo `.env.<ENV>`) e incluye un archivo por grupo en `makefiles/`:

| Archivo                | Tareas                                                         | Uso en el despliegue                                                                              |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `makefiles/app.mk`     | `dev`, `debug`, `clean`                                        | `pnpm dev` equivale a `make dev` (local)                                                          |
| `makefiles/db.mk`      | `deps`, `generate`, `db-deploy`, `migrate`, `seed`, `studio`   | `make deps ENV=prod` / `make db-deploy ENV=prod` hacen a mano lo que el job `db`                  |
| `makefiles/bot.mk`     | `telegram`, `tunnel`, `secret`                                 | `make telegram ENV=prod` hace a mano lo que el job `telegram`; `make tunnel` para el bot en local |
| `makefiles/quality.mk` | `lint`, `format`, `build`, `test`, `test-integration`, `check` | `make check` es lo mismo que el job `check`                                                       |
| `makefiles/eval.mk`    | `eval-replay`, `eval-ai`                                       | no entra al despliegue; `eval-ai` gasta cuota y pide `CONFIRM=yes`                                |
| `makefiles/docker.mk`  | `docker`                                                       | prueba local de la imagen de Railway                                                              |
| `makefiles/notifications.mk` | `redis`, `redis-stop`, `notify`                          | Redis local de los avisos; `make notify JOB=… ENV=prod` corre un job en producción                |

`package.json` solo tiene `pnpm dev` y lo que llaman Railway (`build`, `start:prod`), el CI (`test:ci`, `test:integration`) y husky (`lint`, `format`).

## 1. Turso

1. La base de producción es `kogane-db`. Si hay que crearla: `turso db create kogane-db`.
2. URL: `turso db show kogane-db --url` → `DATABASE_URL`.
3. Token: `turso db tokens create kogane-db` → `DATABASE_AUTH_TOKEN`. Para **rotarlo** (el anterior se pegó en un chat): `turso db tokens invalidate kogane-db` y crear uno nuevo; actualizarlo en Railway, en GitHub y en `.env.prod`.

## 2. Railway

1. Proyecto `kogane` con el servicio `kogane-api` conectado al repo `brandovidal/kogane-api`, rama `main`, con **Auto deploy** y **Wait for CI** activados (Settings → Source).
2. **Settings → Networking → Generate Domain**: la URL pública es `PUBLIC_URL` (hoy `https://kogane-api.up.railway.app`). **No** uses `kogane-api.railway.internal`: es la red privada de Railway y ni Telegram ni Cloudflare llegan a ella.
3. **Variables** del servicio (las lee la app en runtime):

| Variable                                                                 | Valor                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `NODE_ENV`                                                               | `production` (apaga Swagger `/docs` y deja los logs en JSON)                 |
| `API_KEY`                                                                | una nueva: `make secret` (la usa kogane-app en `x-api-key`)                  |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN`                                    | de Turso                                                                     |
| `GROQ_API_KEY`, `GEMINI_API_KEY`                                         | claves de AI (capas gratuitas)                                               |
| `AI_TEXT_PRIMARY`                                                        | `groq` (por defecto) o `gemini`                                              |
| `TELEGRAM_BOT_TOKEN`                                                     | de @BotFather                                                                |
| `TELEGRAM_WEBHOOK_SECRET`                                                | uno nuevo: `make secret`                                                     |
| `TELEGRAM_ALLOWED_CHAT_IDS`                                              | tu `chat_id`                                                                 |
| `PUBLIC_URL`                                                             | la URL del paso 2                                                            |
| `APP_URL`                                                                | la URL de la web (kogane-app): Google devuelve el navegador a `<APP_URL>/api/v1/auth/google/callback` (P23) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                               | cliente OAuth «Aplicación web» de Google Cloud (ver 5c). Sin ellos, solo correo/celular + contraseña |
| `ADMIN_BOOTSTRAP_KEY`                                                    | opcional, la puerta trasera sin terminal (D84): `make secret`. Sin ella no existe |
| `TELEGRAM_BOT_USERNAME`                                                  | opcional; por defecto usa `kogane_finanzas_dev_bot` fuera de producción y `kogane_finanzas_bot` en producción |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 (capturas y notas de voz, D54); ver la sección 4b              |
| `STORAGE_ENV`                                                            | `prod`: carpeta de producción en el bucket (D58). Sin ella la API no arranca |
| `REDIS_URL`                                                              | `${{Redis.REDIS_URL}}` (referencia al servicio Redis, sección 2b). Sin ella no hay avisos |

`PORT` lo pone Railway. El resto de variables de `.env.example` tienen valores por defecto. Entre ellas `OCR_ENABLED` (por defecto `true`: las capturas bancarias pasan primero por el OCR local, P21) y `OCR_CACHE_DIR` (por defecto la carpeta temporal del sistema). El modelo de español (~15 MB) se descarga de jsDelivr con la primera captura después de cada deploy. Con `OCR_ENABLED=false` todas las capturas van a la AI. Pega los valores **sin comillas**.

`railway.json` define el build con el `Dockerfile` y el health check `/v1/health`. Plan Hobby: 5 USD/mes con 5 USD de uso incluido.

## 2b. Redis (avisos y notificaciones, P20)

Los avisos (vencimientos, cierre del día, resumen del domingo, recurrentes) corren con BullMQ sobre Redis (D87). Turso sigue guardando todo; Redis solo tiene las colas y las listas de la campana.

1. En el proyecto de Railway: **New → Database → Add Redis**. Queda en la red privada; no le generes dominio público.
2. Redis de Railway ya viene con `maxmemory-policy noeviction`, que BullMQ necesita para no perder claves (verificado 2026-09-24, [Railway](https://station.railway.com/questions/changing-a-policy-on-redis-instance-12d9a9f6)). Para que las colas sobrevivan un reinicio, en **Settings → Deploy → Custom Start Command** del servicio Redis pon `redis-server --appendonly yes --appendfsync everysec --maxmemory-policy noeviction` ([guía de Railway](https://docs.railway.com/guides/redis-cache-vs-store)).
3. En `kogane-api`, **Variables**: `REDIS_URL=${{Redis.REDIS_URL}}`.
4. En `kogane-api`, **Settings → Serverless**: debe quedar **apagado**. Encendido, Railway duerme el servicio a los 10 minutos sin tráfico y los avisos no salen.
5. Costo: Redis cobra su RAM dentro de los 5 USD del plan Hobby (uno chico, centavos a 1–2 USD al mes).

Verificación: `/v1/health` muestra `redis: OK` y el log dice `reminders scheduled`. Para probar sin esperar la hora: `make notify JOB=due-reminders ENV=prod` (no repite avisos ya enviados). En local, `make dev` levanta Redis en Docker (`make redis`) y `.env.dev` usa `REDIS_URL=redis://localhost:6379`.

## 3. GitHub

**Settings → Environments → `production`** (se crea sola en el primer deploy si no existe) con estos **secretos**:

| Secreto                                         | Lo usa el job                                    |
| ----------------------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN`           | `db` (migraciones y seed)                        |
| `PUBLIC_URL`                                    | `telegram` (`https://kogane-api.up.railway.app`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `telegram` (webhook y menú)                      |

## 4. Telegram

- **Rotar el token** (el anterior se pegó en un chat): en @BotFather, `/revoke` → elegir el bot → token nuevo en Railway, GitHub y tus `.env`.
- El webhook y el menú de comandos los registra el job `telegram` en cada deploy. A mano: `make telegram ENV=prod URL=https://….up.railway.app`.
- Para probar el bot en local: `pnpm dev` en una terminal y `make tunnel` en otra, idealmente con un bot propio de dev (ver "Bot propio para dev").

## 4b. Cloudflare R2 (capturas)

1. R2 → **Create bucket** `kogane` (privado; sin acceso público).
2. R2 → **Manage API tokens → Create API token** con permiso _Object Read & Write_ solo para ese bucket → `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY`; el **Account ID** → `R2_ACCOUNT_ID`.
3. Cargarlas en Railway con `STORAGE_ENV=prod`, y en tu `.env.dev` las mismas claves con `STORAGE_ENV=dev`. `dev` y `prod` siempre usan R2; sin las claves la API no arranca. Solo los tests (`STORAGE_ENV=test`) guardan en disco (`.data/storage-test`).
4. **Valor del token:** la app no lo usa (el Secret Access Key es su SHA-256). Sirve para `wrangler` y la API REST de Cloudflare; guárdalo en tu gestor de contraseñas.
5. **Reglas de ciclo de vida** (respaldo de la limpieza diaria de la API), una sola vez con `npx wrangler login`:

   ```sh
   npx wrangler r2 bucket lifecycle add kogane prod-drafts-expire prod/finance/drafts/ --expire-days 8
   npx wrangler r2 bucket lifecycle add kogane dev-drafts-expire dev/finance/drafts/ --expire-days 3
   ```

**Estructura del bucket (D58).** La base (`bot_files`) guarda solo la clave y los metadatos, nunca los bytes:

```
prod/finance/drafts/<yyyy-mm>/<id>.<ext>       borrador: se borra a los 7 días
prod/finance/expenses/<yyyy>/<mm>/<id>.<ext>   gasto guardado: se conserva
dev/finance/…                                   lo mismo para tu máquina
```

- Guardar un gasto copia el archivo a `expenses/` (CopyObject) y borra el de `drafts/`. La tarea diaria borra los `drafts/` vencidos y deja la fila como `deleted`.
- kogane-app ve la captura con una URL firmada de 10 minutos (R2 permite hasta 7 días; solo funciona con el endpoint S3, no con un dominio propio).
- Cada base limpia solo lo suyo: `dev.db` conoce claves `dev/` y Turso claves `prod/`. El token alcanza todo el bucket (R2 no limita por carpeta), así que la clave de `.env.dev` también podría tocar `prod/`: no la compartas.

Plan gratis: 10 GB, 1 M escrituras y 10 M lecturas al mes, sin cobro de salida.

## 5. Primer deploy

1. Cargar las variables (Railway) y los secretos (GitHub).
2. GitHub → **Actions → Deploy → Run workflow** (o push a `main`).
3. Revisar que pasen los 3 jobs; Railway despliega cuando terminan (Wait for CI).

## 5b. Importar Notion en producción (P14, una sola vez)

Pasos y qué revisar en [`import-notion.md`](import-notion.md).

## 5c. Usuarios y login (P23, una sola vez en producción)

1. **Google (opcional pero recomendado):** console.cloud.google.com → *APIs y servicios ▸ Credenciales ▸ Crear credenciales ▸ ID de cliente de OAuth ▸ Aplicación web*. Origen autorizado: la URL de la web; URI de redireccionamiento: `<APP_URL>/api/v1/auth/google/callback`. Copia el ID y el secreto a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` (Railway) y pon `APP_URL`. En modo «prueba» solo entran los correos de la lista de usuarios de prueba.
2. `make db-deploy ENV=prod` (crea las tablas de usuarios, el dueño `legacy-owner` de todo lo que ya existe y el historial con `userId`).
(Los enlaces que imprimen `make owner`, `make superadmin` y `make user-invite` apuntan solos a la web de cada entorno: `https://kogane-app.brandovidal.workers.dev` con `ENV=prod`, `http://localhost:4000` en dev; se cambia con `APP_URL=<url>` en la línea del comando. `APP_URL` en Railway sigue siendo necesario para Google y para las invitaciones enviadas desde la web.)
3. `make owner EMAIL=brandovidaldeza@gmail.com NAME="Brando Vidal" ROLE=admin ENV=prod`: tus datos pasan a esa cuenta (admin). Imprime un enlace de 7 días para definir una contraseña; con Google basta entrar con ese correo.
4. `make superadmin EMAIL=yisusdracon@gmail.com PHONE=930764207 DNI=<dni> ENV=prod`: crea al superadmin (con su propio «Yo», categorías y grupos) y su enlace. Sin terminal: `POST /v1/admin/superadmins` con el header `x-admin-key`.
5. Entra a la web con tu cuenta, ve a **Perfil ▸ Vincular Telegram** y abre el enlace: el chat queda de tu cuenta. Después vacía `TELEGRAM_ALLOWED_CHAT_IDS` (mientras esté, ese chat sigue actuando como dueño de lo anterior).
6. **Correo de invitación (opcional):** desde la cuenta de Gmail del superadmin, sin dominio. En esa cuenta activa la verificación en dos pasos y crea una **contraseña de aplicación** (myaccount.google.com/apppasswords: no es la contraseña normal de Gmail). Ponla en `SMTP_APP_PASSWORD` con `SMTP_USER=yisusdracon@gmail.com` y `SMTP_FROM_NAME=Kogane`. Con eso, **Configuración ▸ Usuarios ▸ Invitar** envía el correo (y siempre muestra el enlace por si no sale), y `make user-invite EMAIL=… SEND=yes` también. Gmail deja unos 500 correos al día: de sobra.
7. **Configuración ▸ Usuarios** (admin): invita a otras personas.
8. Con el login propio, Cloudflare Access (D53) queda opcional: quítalo o déjalo como segunda capa.

## 6. Verificación

- `curl https://…/v1/health` → `database: OK`, `redis: OK` y `telegram.webhook: OK`.
- `https://…/docs` → **404** (Swagger apagado en producción).
- Desde Telegram: un texto, una foto de Yape y una nota de voz se guardan; `/uso` muestra la cuota del día y la línea "OCR local" después de la primera captura bancaria.
- Un álbum de 2 o más capturas responde con una sola lista (✅ Guardar todos · 📝 Revisar uno por uno · 📝 Borrador).
- Imagen igual a la de Railway: `make docker` la construye, la arranca sin secretos y comprueba `/v1/health` 200 y `/docs` 404. El CI corre lo mismo antes de cada deploy.
- Antes de hacer push: `make check` (lo mismo que el job `check`).

## 6b. Si Railway responde 502 "Application failed to respond"

La app no arrancó. Railway → Deployments → el último → **Deploy Logs**:

- `DATABASE_URL is not set` o `DATABASE_AUTH_TOKEN is not set for Turso`: falta la variable (o se pegó con comillas).
- `URL_INVALID`: la URL de Turso tiene comillas o espacios.
- `STORAGE_ENV must be dev, prod or test` o `R2_… are required`: faltan `STORAGE_ENV=prod` o las claves de R2 (sección 4b).
- `Cannot find module './internal/class.ts'`: el cliente de Prisma se generó con imports `.ts`. Lo evita `importFileExtension = ""` en `prisma/schema.prisma`; el job `image` del CI (`make docker`) frena el deploy si la imagen no arranca.
- Ningún error y el health check falla: revisar que el servicio use el `Dockerfile` (`railway.json`) y que `PORT` no esté fijado a mano.

## 7. Volver atrás

- **Código:** Railway → Deployments → el deploy anterior → **Redeploy**.
- **Base:** las migraciones solo avanzan. Si una falla, el job `db` corta el pipeline antes de desplegar; se corrige con una migración nueva.
- **Webhook:** si la API no responde, Telegram guarda los mensajes 24 h y los reintenta; `/v1/health` muestra los pendientes.
