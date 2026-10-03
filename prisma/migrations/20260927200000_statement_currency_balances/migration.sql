CREATE TABLE "cat_currencies" (
  "code" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "symbol" TEXT NOT NULL
);
INSERT INTO "cat_currencies" ("code", "name", "symbol") VALUES ('PEN', 'Soles', 'S/'), ('USD', 'Dólares', 'US$');
ALTER TABLE "imp_statements" ADD COLUMN "currencyReviewRequired" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "imp_statement_balances" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT, "statementId" TEXT NOT NULL,
 "currency" TEXT NOT NULL, "totalDue" REAL, "minimumDue" REAL, "previousBalance" REAL,
 "previousPayments" REAL, "monthlyPayment" REAL, "minimumAllocations" TEXT,
 CONSTRAINT "imp_statement_balances_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "imp_statements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "imp_statement_balances_currency_fkey" FOREIGN KEY ("currency") REFERENCES "cat_currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "imp_statement_balances_statementId_currency_key" ON "imp_statement_balances"("statementId", "currency");
CREATE INDEX "imp_statement_balances_userId_idx" ON "imp_statement_balances"("userId");
-- Preserve legacy values without guessing a currency from an amount. Re-read the PDF to verify them.
INSERT INTO "imp_statement_balances" ("id", "userId", "statementId", "currency", "totalDue", "minimumDue", "previousBalance", "previousPayments", "monthlyPayment", "minimumAllocations")
SELECT 'legacy:' || "id", "userId", "id", "currency", "totalDue", "minimumDue", "previous_balance", "previous_payments", "monthly_payment", "minimumAllocations" FROM "imp_statements";
UPDATE "imp_statements" SET "currencyReviewRequired" = true;
