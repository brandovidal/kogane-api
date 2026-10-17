-- Cuentas de salida (where the money leaves from) and the trace of the payments registered from the calendar
CREATE TABLE "cat_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "bank" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "exp_payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "kind" TEXT NOT NULL,
    "paidAt" DATETIME NOT NULL,
    "method" TEXT,
    "accountId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exp_payments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "cat_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "cat_accounts_userId_idx" ON "cat_accounts"("userId");
CREATE UNIQUE INDEX "cat_accounts_userId_name_key" ON "cat_accounts"("userId", "name");
CREATE INDEX "exp_payments_userId_idx" ON "exp_payments"("userId");
CREATE INDEX "exp_payments_refType_refId_idx" ON "exp_payments"("refType", "refId");
CREATE INDEX "exp_payments_accountId_idx" ON "exp_payments"("accountId");
