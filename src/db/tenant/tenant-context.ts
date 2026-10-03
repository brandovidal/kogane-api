import { AsyncLocalStorage } from 'node:async_hooks'

// Whose data this code is working with (P23, D82). The tenancy extension of PrismaService reads it: every query of a
// table with a userId is filtered by it and every insert carries it, so no repository has to remember.
export interface TenantStore {
  userId?: string
  system?: boolean // jobs and scripts that work across users: nothing is filtered
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>()

// The work is awaited INSIDE the context: a Prisma query is lazy (it starts when it is awaited), so a bare
// `runWithUser(id, () => prisma.x.findMany())` would run it later, outside the user
export const runWithUser = <T>(userId: string, work: () => T | Promise<T>): Promise<T> =>
  tenantStorage.run({ userId }, async () => await work())

// Only for what is not a user's: boot, migrations, scripts. A query outside a user or a system context fails
export const runAsSystem = <T>(work: () => T | Promise<T>): Promise<T> =>
  tenantStorage.run({ system: true }, async () => await work())

export const currentUserId = (): string | undefined => tenantStorage.getStore()?.userId

// The user of the request; a code path without one is a bug (a job that forgot to run per user)
export function requireUserId(): string {
  const userId = currentUserId()
  if (!userId) throw new Error('No user in this context: run it with runWithUser (or runAsSystem for a script)')
  return userId
}

// Not a user's data: the users themselves, their sessions and the AI quota, shared by everyone
export const TENANT_EXCLUDED_MODELS = new Set([
  'AuthUser',
  'AuthInvite',
  'AuthSession',
  'AuthToken',
  'AuthAttempt',
  'AuditContext',
  'AiRequestLog',
  'CurrencyCatalog', // public ISO codes; no user data
])
