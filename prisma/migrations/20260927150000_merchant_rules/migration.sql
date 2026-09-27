-- P18 (D129): what the bot learns from the corrections of category and payment method. Backward compatible: a new table
-- CreateTable
CREATE TABLE "cat_merchant_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "merchant" TEXT NOT NULL,
    "categoryId" TEXT,
    "paymentMethodId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "cat_merchant_rules_userId_merchant_key" ON "cat_merchant_rules"("userId", "merchant");

-- CreateIndex
CREATE INDEX "cat_merchant_rules_userId_idx" ON "cat_merchant_rules"("userId");
