// Screenshots and voice notes in R2 (D54, D58)
export enum StoredFileStatus {
  TEMPORARY = 'temporary', // <env>/finance/drafts/…: the draft is still pending, deleted after TEMPORARY_FILE_DAYS
  KEPT = 'kept', // <env>/finance/expenses/…: an expense that uses it was saved, never deleted
  DELETED = 'deleted', // removed from the bucket; the row stays as history
}

export const TEMPORARY_FILE_DAYS = 7
// Parent folder of each environment in the bucket (D58). dev and prod always use R2; only tests use the disk
export enum StorageEnv {
  PROD = 'prod',
  DEV = 'dev',
  QA = 'qa',
  TEST = 'test',
}

// Bucket layout (D58): <env>/finance/drafts/<yyyy-mm>/<id>.<ext> (expires, R2 lifecycle rule too) →
// <env>/finance/expenses/<yyyy>/<mm>/<id>.<ext> (kept). The bytes never go to the database: bot_files only keeps
// the full key.
export const FILES_ROOT = 'finance'
export const DRAFTS_FOLDER = 'drafts'
export const EXPENSES_FOLDER = 'expenses'

// Files deleted per run of the files-cleanup job (every 6 h, NotificationJob.FILES_CLEANUP)
export const FILE_CLEANUP_BATCH = 100

// Signed links to see a file in kogane-app (R2 allows up to 7 days)
export const FILE_URL_TTL_SECONDS = 10 * 60

// Attachments of loans, investments and expenses (P27, D100): <env>/finance/<folder>/<yyyy>/<mm>/<id>.<ext>, kept for good
export const ATTACHMENTS_CHANNEL = 'web'
