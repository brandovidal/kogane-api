import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import {
  AuthTokenKind,
  IMPERSONATION_HOURS,
  LEGACY_OWNER_ID,
  LINK_CODE_MINUTES,
  LOGIN_LOCK_MINUTES,
  MAX_LOGIN_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
  SESSION_DAYS,
  UserRole,
  UserStatus,
} from '@/commons/constants/auth.constant'
import { ForbiddenRoleException } from '@/commons/exceptions/auth/forbidden-role.exception'
import { GoogleAccountLinkException } from '@/commons/exceptions/auth/google-account-link.exception'
import { SessionRequiredException } from '@/commons/exceptions/auth/session-required.exception'
import { UserNotFoundException } from '@/commons/exceptions/auth/user-not-found.exception'
import { InvalidCredentialsException } from '@/commons/exceptions/auth/invalid-credentials.exception'
import { InviteInvalidException } from '@/commons/exceptions/auth/invite-invalid.exception'
import { LinkCodeInvalidException } from '@/commons/exceptions/auth/link-code-invalid.exception'
import { ResetLinkInvalidException } from '@/commons/exceptions/auth/reset-link-invalid.exception'
import { NotInvitedException } from '@/commons/exceptions/auth/not-invited.exception'
import { TooManyAttemptsException } from '@/commons/exceptions/auth/too-many-attempts.exception'
import { UserDisabledException } from '@/commons/exceptions/auth/user-disabled.exception'
import { WeakPasswordException } from '@/commons/exceptions/auth/weak-password.exception'
import { hashPassword, verifyPassword } from '@/commons/helpers/password.helper'
import { normalizePhone } from '@/commons/helpers/phone.helper'
import { generateLinkCode, generateToken, hashToken } from '@/commons/helpers/token.helper'
import { AuthDBRepository } from '@/db/models/auth/authDB.repository'
import { AuthUser } from '@/generated/prisma/client'
import { TelegramConfig } from '@/settings/settings.model'

import { GoogleProfile } from './google-oauth.service'
import { UserProvisioningService } from './user-provisioning.service'

const SESSION_CACHE_MS = 20_000
const DAY_MS = 24 * 60 * 60_000

export interface ValidSession {
  user: AuthUser
  impersonatedBy: AuthUser | null
}

export interface SessionUser {
  id: string
  name: string
  email: string
  role: UserRole
  status: UserStatus
  phone: string | null
  hasPassword: boolean
  googleLinked: boolean
  telegramLinked: boolean
  lastLoginAt: Date | null
  impersonatedBy: { id: string; name: string } | null // a superadmin who entered as this user
}

export const toSessionUser = (user: AuthUser, impersonatedBy: AuthUser | null = null): SessionUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role as UserRole,
  status: user.status as UserStatus,
  phone: user.phone,
  hasPassword: !!user.passwordHash,
  googleLinked: !!user.googleSub,
  telegramLinked: !!user.telegramChatId,
  lastLoginAt: user.lastLoginAt,
  impersonatedBy: impersonatedBy ? { id: impersonatedBy.id, name: impersonatedBy.name } : null,
})

// Sign-in with a password or Google, opaque revocable sessions and the Telegram link (P23, D82–D85). Invitation only:
// nobody registers without one, and without a domain there is no mail to verify (D91), so the invitation link is the
// proof of the email (or Google, which already verified it)
@Injectable()
export class AuthService {
  // A short memory of valid sessions: one read of the database per request would be a round trip to Turso each time
  private readonly sessions = new Map<string, { session: ValidSession; checkedAt: number }>()

  constructor(
    private readonly authDBRepository: AuthDBRepository,
    private readonly userProvisioningService: UserProvisioningService,
    private readonly configService: ConfigService,
  ) {}

  // ==================== Password ====================

  // The email or the mobile that an admin registered, and the password
  async login(identifier: string, password: string): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
    const key = identifier.includes('@')
      ? identifier.trim().toLowerCase()
      : (normalizePhone(identifier) ?? identifier.trim())
    const since = new Date(Date.now() - LOGIN_LOCK_MINUTES * 60_000)
    if ((await this.authDBRepository.countFailedAttempts(key, since)) >= MAX_LOGIN_ATTEMPTS) {
      throw new TooManyAttemptsException()
    }

    const user = key.includes('@')
      ? await this.authDBRepository.findUserByEmail(key)
      : await this.authDBRepository.findUserByPhone(key)
    // The hash is checked even when the email is unknown, so the time does not say which emails exist
    const valid = await verifyPassword(password, user?.passwordHash ?? null)
    if (!user || !valid) {
      await this.authDBRepository.recordFailedAttempt(key)
      throw new InvalidCredentialsException()
    }
    await this.authDBRepository.clearAttempts(key)
    return this.startSession(user)
  }

  async changePassword(userId: string, current: string | undefined, next: string): Promise<void> {
    const user = (await this.authDBRepository.findUserById(userId))!
    if (user.passwordHash && !(await verifyPassword(current ?? '', user.passwordHash)))
      throw new InvalidCredentialsException()
    if (next.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordException()
    await this.authDBRepository.updateUser(userId, { passwordHash: await hashPassword(next) })
  }

  // "¿Olvidaste tu contraseña?": the one-use link proves the email (like an invitation); every session of the account
  // is closed and the new one starts here
  async resetPassword(input: { token: string; password: string }) {
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordException()
    const token = await this.authDBRepository.consumeToken(
      AuthTokenKind.PASSWORD_RESET,
      hashToken(input.token),
      new Date(),
    )
    const user = token?.userId ? await this.authDBRepository.findUserById(token.userId) : null
    if (!user) throw new ResetLinkInvalidException()
    if (user.status === UserStatus.DISABLED) throw new UserDisabledException()
    await this.revokeSessionsOf(user.id)
    const updated = await this.authDBRepository.updateUser(user.id, {
      passwordHash: await hashPassword(input.password),
      status: UserStatus.ACTIVE,
    })
    await this.authDBRepository.clearAttempts(updated.email)
    return this.startSession(updated)
  }

  // ==================== Invitations ====================

  async previewInvite(token: string): Promise<{ email: string; role: UserRole }> {
    const invite = await this.findUsableInvite(token)
    return { email: invite.email, role: invite.role as UserRole }
  }

  // The invitation proves the email: they choose a password and are in. An email that already exists (the claimed
  // owner, a superadmin created by script) only gets its password
  async acceptInvite(input: { token: string; name?: string; password: string }) {
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordException()
    const invite = await this.findUsableInvite(input.token)
    const passwordHash = await hashPassword(input.password)

    const existing = await this.authDBRepository.findUserByEmail(invite.email)
    const user = existing
      ? await this.authDBRepository.updateUser(existing.id, { passwordHash, status: UserStatus.ACTIVE })
      : await this.createUser({
          email: invite.email,
          name: input.name ?? invite.email.split('@')[0],
          role: invite.role,
          passwordHash,
        })
    await this.authDBRepository.markInviteUsed(invite.id, new Date())
    return this.startSession(user)
  }

  // ==================== Google ====================

  // Signed in with a verified Google account: a known user (by Google id or by email), or an invitation for that email
  async signInWithGoogle(profile: GoogleProfile, inviteToken: string | null) {
    let user =
      (await this.authDBRepository.findUserByGoogleSub(profile.sub)) ??
      (await this.authDBRepository.findUserByEmail(profile.email))

    if (!user) {
      const invite = inviteToken
        ? await this.authDBRepository.findInviteByHash(hashToken(inviteToken))
        : await this.authDBRepository.findPendingInviteByEmail(profile.email, new Date())
      // An invitation is for one email: another Google account cannot use it
      if (!invite || invite.usedAt || invite.expiresAt < new Date() || invite.email !== profile.email) {
        throw new NotInvitedException({ email: profile.email })
      }
      user = await this.createUser({
        email: profile.email,
        name: profile.name,
        role: invite.role,
        googleSub: profile.sub,
      })
      await this.authDBRepository.markInviteUsed(invite.id, new Date())
    } else if (!user.googleSub || user.status === UserStatus.INVITED) {
      user = await this.authDBRepository.updateUser(user.id, {
        googleSub: user.googleSub ?? profile.sub,
        status: user.status === UserStatus.DISABLED ? user.status : UserStatus.ACTIVE,
      })
    }
    return this.startSession(user)
  }

  async linkGoogleAccount(userId: string, profile: GoogleProfile): Promise<void> {
    const user = await this.authDBRepository.findUserById(userId)
    if (!user || user.email.toLowerCase() !== profile.email.toLowerCase()) {
      throw new GoogleAccountLinkException('email_mismatch')
    }
    const linkedUser = await this.authDBRepository.findUserByGoogleSub(profile.sub)
    if (linkedUser && linkedUser.id !== user.id) throw new GoogleAccountLinkException('already_linked')
    if (user.googleSub && user.googleSub !== profile.sub) throw new GoogleAccountLinkException('already_linked')
    if (!user.googleSub) await this.authDBRepository.updateUser(user.id, { googleSub: profile.sub })
  }

  // ==================== Sessions ====================

  private async startSession(user: AuthUser): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
    if (user.status === UserStatus.DISABLED) throw new UserDisabledException()
    const token = generateToken()
    const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS)
    await this.authDBRepository.createSession(user.id, hashToken(token), expiresAt)
    const updated = await this.authDBRepository.updateUser(user.id, { lastLoginAt: new Date() })
    void this.authDBRepository.deleteExpiredSessions(new Date()).catch(() => undefined)
    return { user: updated, token, expiresAt }
  }

  // The user of a session cookie (and the superadmin behind it, when they entered as this user), or null: unknown,
  // expired, or a disabled user
  async validateSession(token: string): Promise<ValidSession | null> {
    const tokenHash = hashToken(token)
    const cached = this.sessions.get(tokenHash)
    if (cached && Date.now() - cached.checkedAt < SESSION_CACHE_MS) return cached.session

    const found = await this.authDBRepository.findSession(tokenHash)
    if (!found || found.expiresAt < new Date() || found.user.status !== UserStatus.ACTIVE) {
      this.sessions.delete(tokenHash)
      return null
    }
    const impersonatedBy = found.impersonatedById
      ? await this.authDBRepository.findUserById(found.impersonatedById)
      : null
    // The superadmin behind a visit must still be one and active: demoting them closes the visit
    if (
      found.impersonatedById &&
      (!impersonatedBy || impersonatedBy.role !== UserRole.SUPERADMIN || impersonatedBy.status !== UserStatus.ACTIVE)
    ) {
      return null
    }
    const session = { user: found.user, impersonatedBy }
    this.sessions.set(tokenHash, { session, checkedAt: Date.now() })
    return session
  }

  // ==================== The backdoor (D84) ====================

  // A superadmin enters as another user to see what they see or fix what they cannot: a short session that says who is
  // behind it (the history records the superadmin as the actor)
  async impersonate(actor: AuthUser, targetId: string): Promise<{ token: string; expiresAt: Date; user: AuthUser }> {
    const target = await this.authDBRepository.findUserById(targetId)
    if (!target) throw new UserNotFoundException({ id: targetId })
    if (target.status !== UserStatus.ACTIVE || target.id === actor.id) throw new ForbiddenRoleException()
    const token = generateToken()
    const expiresAt = new Date(Date.now() + IMPERSONATION_HOURS * 60 * 60_000)
    await this.authDBRepository.createSession(target.id, hashToken(token), expiresAt, actor.id)
    return { token, expiresAt, user: target }
  }

  // Back to the superadmin: their own new session, and the visit is over
  async stopImpersonation(token: string): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
    const session = await this.validateSession(token)
    if (!session?.impersonatedBy) throw new SessionRequiredException()
    await this.logout(token)
    return this.startSession(session.impersonatedBy)
  }

  async logout(token: string): Promise<void> {
    this.sessions.delete(hashToken(token))
    await this.authDBRepository.deleteSession(hashToken(token))
  }

  // A disabled user is out at once: their sessions go and the memory forgets them
  async revokeSessionsOf(userId: string): Promise<void> {
    for (const [hash, entry] of this.sessions) if (entry.session.user.id === userId) this.sessions.delete(hash)
    await this.authDBRepository.deleteSessionsOf(userId)
  }

  // ==================== Telegram (D85) ====================

  // The link they open in Telegram: t.me/<bot>?start=<code>
  async createTelegramLink(userId: string): Promise<{ url: string; expiresAt: Date }> {
    const code = generateLinkCode()
    const expiresAt = new Date(Date.now() + LINK_CODE_MINUTES * 60_000)
    await this.authDBRepository.createToken({
      kind: AuthTokenKind.TELEGRAM_LINK,
      userId,
      tokenHash: hashToken(code),
      expiresAt,
    })
    const { botUsername } = this.configService.getOrThrow<TelegramConfig>('telegram')
    return { url: `https://t.me/${botUsername}?start=${code}`, expiresAt }
  }

  // /start <code> in a chat: that chat now belongs to the user of the code
  async linkTelegram(code: string, chatId: string): Promise<AuthUser> {
    const token = await this.authDBRepository.consumeToken(AuthTokenKind.TELEGRAM_LINK, hashToken(code), new Date())
    if (!token?.userId) throw new LinkCodeInvalidException()
    const taken = await this.authDBRepository.findUserByTelegramChat(chatId)
    if (taken && taken.id !== token.userId) await this.authDBRepository.updateUser(taken.id, { telegramChatId: null })
    return this.authDBRepository.updateUser(token.userId, { telegramChatId: chatId })
  }

  async unlinkTelegram(userId: string): Promise<void> {
    await this.authDBRepository.updateUser(userId, { telegramChatId: null })
  }

  // The user behind a chat: linked, or the legacy owner while TELEGRAM_ALLOWED_CHAT_IDS still lists it (the bot worked
  // that way before P23: the allowlist can be emptied once the chat is linked)
  async userOfChat(chatId: string): Promise<AuthUser | null> {
    const linked = await this.authDBRepository.findUserByTelegramChat(chatId)
    if (linked) return linked.status === UserStatus.ACTIVE ? linked : null
    const allowed = this.configService.get<TelegramConfig>('telegram')?.allowedChatIds.includes(chatId)
    return allowed ? this.authDBRepository.findUserById(LEGACY_OWNER_ID) : null
  }

  // Where to send a user's notices: their linked chat, and the allowlisted chats for the legacy owner (see userOfChat)
  async chatIdsOf(userId: string): Promise<string[]> {
    const user = await this.authDBRepository.findUserById(userId)
    if (!user || user.status !== UserStatus.ACTIVE) return []
    if (user.telegramChatId) return [user.telegramChatId]
    return userId === LEGACY_OWNER_ID ? (this.configService.get<TelegramConfig>('telegram')?.allowedChatIds ?? []) : []
  }

  // ==================== helpers ====================

  private async findUsableInvite(token: string) {
    const invite = await this.authDBRepository.findInviteByHash(hashToken(token))
    if (!invite || invite.usedAt || invite.expiresAt < new Date()) throw new InviteInvalidException()
    return invite
  }

  // A new account starts with its own budget groups, categories and "Yo" (D97)
  private async createUser(data: {
    email: string
    name: string
    role: string
    googleSub?: string
    passwordHash?: string
  }): Promise<AuthUser> {
    const user = await this.authDBRepository.createUser({ ...data, status: UserStatus.ACTIVE })
    await this.userProvisioningService.provision(user)
    return user
  }
}
