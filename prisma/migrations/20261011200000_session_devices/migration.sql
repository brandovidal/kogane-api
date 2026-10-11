-- Perfil ▸ Dispositivos: what each session says about where it was opened (nullable: existing sessions have none)
ALTER TABLE "auth_sessions" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "auth_sessions" ADD COLUMN "ipAddress" TEXT;
