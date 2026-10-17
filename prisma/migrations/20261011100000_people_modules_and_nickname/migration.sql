-- AlterTable
ALTER TABLE "cat_people" ADD COLUMN "appearsIn" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "auth_users" ADD COLUMN "nickname" TEXT;

-- Backfill: a person appears in the pages where they already have records (the owner appears in all of them)
UPDATE "cat_people" SET "appearsIn" = (
  SELECT COALESCE(json_group_array(m), '[]') FROM (
    SELECT 'fixed_costs' AS m WHERE "isDefault" = 1 OR EXISTS (SELECT 1 FROM "exp_fixed_costs" f WHERE f."personId" = "cat_people"."id")
    UNION ALL
    SELECT 'platforms' WHERE "isDefault" = 1 OR EXISTS (SELECT 1 FROM "exp_subscriptions" s WHERE s."personId" = "cat_people"."id" AND s."kind" = 'platform')
    UNION ALL
    SELECT 'cards' WHERE "isDefault" = 1
      OR EXISTS (SELECT 1 FROM "exp_credit_card_expenses" c WHERE c."personId" = "cat_people"."id")
      OR EXISTS (SELECT 1 FROM "cat_card_holders" h WHERE h."personId" = "cat_people"."id")
    UNION ALL
    SELECT 'recurring' WHERE "isDefault" = 1
      OR EXISTS (SELECT 1 FROM "exp_recurring_expenses" r WHERE r."personId" = "cat_people"."id")
      OR EXISTS (SELECT 1 FROM "exp_subscriptions" s WHERE s."personId" = "cat_people"."id" AND s."kind" <> 'platform')
  )
);
