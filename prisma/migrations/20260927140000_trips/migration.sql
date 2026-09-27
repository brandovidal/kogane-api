-- P18 (D128): /viaje tags the expenses saved while a trip is open. Backward compatible: a table and two nullable columns
-- CreateTable
CREATE TABLE "exp_trips" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AlterTable
ALTER TABLE "exp_daily_expenses" ADD COLUMN "tripId" TEXT REFERENCES "exp_trips" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "exp_credit_card_expenses" ADD COLUMN "tripId" TEXT REFERENCES "exp_trips" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "exp_trips_userId_idx" ON "exp_trips"("userId");

-- CreateIndex
CREATE INDEX "exp_trips_endedAt_idx" ON "exp_trips"("endedAt");

-- CreateIndex
CREATE INDEX "exp_daily_expenses_tripId_idx" ON "exp_daily_expenses"("tripId");

-- CreateIndex
CREATE INDEX "exp_credit_card_expenses_tripId_idx" ON "exp_credit_card_expenses"("tripId");
