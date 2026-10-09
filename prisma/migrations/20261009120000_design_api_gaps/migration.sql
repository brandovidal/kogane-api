-- The gaps of the design that needed the API (kogane-app boards). Backward compatible: new nullable columns and a new
-- table. statementPassword (I12) is kept like the DNI (D94) and masked in the history; reviewedAt is "Marcar como
-- revisados" of Tarjetas; carriedFrom* is "Arrastrar saldos pendientes"; exp_person_summaries is Resumen by person

-- AlterTable
ALTER TABLE "cat_payment_methods" ADD COLUMN "statementPassword" TEXT;

-- AlterTable
ALTER TABLE "exp_credit_card_expenses" ADD COLUMN "reviewedAt" DATETIME;

-- AlterTable
ALTER TABLE "exp_debts" ADD COLUMN "carriedFromMonth" INTEGER;

-- AlterTable
ALTER TABLE "exp_debts" ADD COLUMN "carriedFromYear" INTEGER;

-- CreateTable
CREATE TABLE "exp_person_summaries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "personId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "cutoffDate" DATETIME,
    "collectBy" DATETIME,
    "note" TEXT,
    "adjustments" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "exp_person_summaries_personId_fkey" FOREIGN KEY ("personId") REFERENCES "cat_people" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "exp_person_summaries_userId_year_month_idx" ON "exp_person_summaries"("userId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "exp_person_summaries_userId_personId_year_month_key" ON "exp_person_summaries"("userId", "personId", "year", "month");
