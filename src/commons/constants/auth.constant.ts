export const API_KEY_HEADER = 'x-api-key'

// Login and sessions (P23, D82–D84)
export const SESSION_COOKIE = 'kogane_session'
export const OAUTH_STATE_COOKIE = 'kogane_oauth'
export const SESSION_DAYS = 30
export const INVITE_DAYS = 7
export const LINK_CODE_MINUTES = 15 // the code that links a Telegram chat to a user
export const PASSWORD_RESET_MINUTES = 60 // the link of "¿Olvidaste tu contraseña?"
export const OAUTH_STATE_MINUTES = 10
export const MAX_LOGIN_ATTEMPTS = 5 // failed sign-ins per email…
export const LOGIN_LOCK_MINUTES = 15 // …in this window
export const MIN_PASSWORD_LENGTH = 10

// The user that owns the data that existed before P23 (created by the migration); `make owner EMAIL=…` claims it
export const LEGACY_OWNER_ID = 'legacy-owner'

export enum UserRole {
  SUPERADMIN = 'superadmin', // only created by `make superadmin`: nobody gives it from the web
  ADMIN = 'admin', // invites, activates and disables users
  MEMBER = 'member',
}

export enum UserStatus {
  INVITED = 'invited', // known email, has not signed in yet
  ACTIVE = 'active',
  DISABLED = 'disabled', // no session works
}

export enum AuthTokenKind {
  TELEGRAM_LINK = 'telegram_link',
  GOOGLE_STATE = 'google_state',
  PASSWORD_RESET = 'password_reset',
}

// Each role can do what the ones below it do: the superadmin is everything (and can enter as any user, the backdoor of
// D84), an admin is also a member
const ROLE_RANK: Record<string, number> = { [UserRole.MEMBER]: 1, [UserRole.ADMIN]: 2, [UserRole.SUPERADMIN]: 3 }
export const hasRole = (role: string, minimum: UserRole): boolean => (ROLE_RANK[role] ?? 0) >= ROLE_RANK[minimum]

export const IMPERSONATION_HOURS = 4 // a superadmin's visit as another user is short
export const ADMIN_KEY_HEADER = 'x-admin-key' // POST /v1/admin/superadmins: the bootstrap key of the backdoor
