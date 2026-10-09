import { ConfigService } from '@nestjs/config'
import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { LEGACY_OWNER_ID, UserRole, UserStatus } from '@/commons/constants/auth.constant'
import { InvalidCredentialsException } from '@/commons/exceptions/auth/invalid-credentials.exception'
import { InviteInvalidException } from '@/commons/exceptions/auth/invite-invalid.exception'
import { LinkCodeInvalidException } from '@/commons/exceptions/auth/link-code-invalid.exception'
import { ResetLinkInvalidException } from '@/commons/exceptions/auth/reset-link-invalid.exception'
import { NotInvitedException } from '@/commons/exceptions/auth/not-invited.exception'
import { TooManyAttemptsException } from '@/commons/exceptions/auth/too-many-attempts.exception'
import { UserDisabledException } from '@/commons/exceptions/auth/user-disabled.exception'
import { WeakPasswordException } from '@/commons/exceptions/auth/weak-password.exception'
import { ForbiddenRoleException } from '@/commons/exceptions/auth/forbidden-role.exception'
import { hashPassword } from '@/commons/helpers/password.helper'
import { hashToken } from '@/commons/helpers/token.helper'
import { AuthDBRepository } from '@/db/models/auth/authDB.repository'

import { AuthService } from './auth.service'
import { UserProvisioningService } from './user-provisioning.service'

const mockDB = {
  findUserByEmail: vi.fn(),
  findUserByPhone: vi.fn(),
  findUserById: vi.fn(),
  findUserByGoogleSub: vi.fn(),
  findUserByTelegramChat: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  createSession: vi.fn(),
  findSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteSessionsOf: vi.fn(),
  deleteExpiredSessions: vi.fn(),
  findInviteByHash: vi.fn(),
  findPendingInviteByEmail: vi.fn(),
  markInviteUsed: vi.fn(),
  createToken: vi.fn(),
  consumeToken: vi.fn(),
  recordFailedAttempt: vi.fn(),
  countFailedAttempts: vi.fn(),
  clearAttempts: vi.fn(),
}
const mockProvisioning = { provision: vi.fn() }

const user = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  name: 'Brando',
  email: 'brando@example.com',
  googleSub: null,
  phone: null,
  documentNumber: null,
  passwordHash: null,
  role: UserRole.MEMBER,
  status: UserStatus.ACTIVE,
  telegramChatId: null,
  lastLoginAt: null,
  ...overrides,
})

describe('AuthService', () => {
  let service: AuthService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AuthDBRepository, useValue: mockDB },
        { provide: UserProvisioningService, useValue: mockProvisioning },
        {
          provide: ConfigService,
          useValue: new ConfigService({ telegram: { botUsername: 'kogane_bot', allowedChatIds: ['555'] } }),
        },
      ],
    }).compile()
    service = module.get(AuthService)

    mockDB.countFailedAttempts.mockResolvedValue(0)
    mockDB.createSession.mockResolvedValue({})
    mockDB.deleteExpiredSessions.mockResolvedValue(undefined)
    mockDB.updateUser.mockImplementation(async (id: string, data: Record<string, unknown>) => user({ id, ...data }))
    mockDB.createUser.mockImplementation(async (data: Record<string, unknown>) => user({ id: 'new', ...data }))
  })

  afterEach(() => vi.resetAllMocks())

  describe('login', () => {
    it('should open a session with the right password and never keep the token itself', async () => {
      mockDB.findUserByEmail.mockResolvedValue(user({ passwordHash: await hashPassword('una-clave-larga') }))

      const { token } = await service.login('Brando@Example.com', 'una-clave-larga')

      expect(mockDB.findUserByEmail).toHaveBeenCalledWith('brando@example.com')
      expect(mockDB.createSession).toHaveBeenCalledWith('u1', hashToken(token), expect.any(Date))
      expect(mockDB.clearAttempts).toHaveBeenCalledWith('brando@example.com')
    })

    it('should also accept the mobile an admin registered, in any format', async () => {
      mockDB.findUserByPhone.mockResolvedValue(
        user({ phone: '930764207', passwordHash: await hashPassword('una-clave-larga') }),
      )

      await service.login('+51 930 764 207', 'una-clave-larga')

      expect(mockDB.findUserByPhone).toHaveBeenCalledWith('930764207')
    })

    it('should not say whether the email exists, and count the failure', async () => {
      mockDB.findUserByEmail.mockResolvedValue(null)

      await expect(service.login('nadie@example.com', 'cualquiera-larga')).rejects.toThrow(InvalidCredentialsException)
      expect(mockDB.recordFailedAttempt).toHaveBeenCalledWith('nadie@example.com')
    })

    it('should lock an identifier after 5 failures', async () => {
      mockDB.countFailedAttempts.mockResolvedValue(5)

      await expect(service.login('brando@example.com', 'x')).rejects.toThrow(TooManyAttemptsException)
      expect(mockDB.findUserByEmail).not.toHaveBeenCalled()
    })

    it('should not sign in a disabled account', async () => {
      mockDB.findUserByEmail.mockResolvedValue(
        user({ status: UserStatus.DISABLED, passwordHash: await hashPassword('una-clave-larga') }),
      )

      await expect(service.login('brando@example.com', 'una-clave-larga')).rejects.toThrow(UserDisabledException)
    })
  })

  describe('invitations', () => {
    const invite = (overrides: Record<string, unknown> = {}) => ({
      id: 'i1',
      email: 'sobrino@example.com',
      role: UserRole.MEMBER,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    })

    it('should create the account of an invitation with its email, start it with its own catalogs and use it up', async () => {
      mockDB.findInviteByHash.mockResolvedValue(invite())
      mockDB.findUserByEmail.mockResolvedValue(null)

      await service.acceptInvite({
        token: 'tok-tok-tok-tok',
        name: 'Sobrino',
        password: 'una-clave-larga',
      })

      expect(mockDB.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'sobrino@example.com', name: 'Sobrino', status: 'active' }),
      )
      expect(mockProvisioning.provision).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }))
      expect(mockDB.markInviteUsed).toHaveBeenCalledWith('i1', expect.any(Date))
    })

    it('should only set the password of an account that exists (the owner, a superadmin made by script)', async () => {
      mockDB.findInviteByHash.mockResolvedValue(invite({ email: 'brando@example.com' }))
      mockDB.findUserByEmail.mockResolvedValue(user())

      await service.acceptInvite({ token: 'tok-tok-tok-tok', password: 'una-clave-larga' })

      expect(mockDB.createUser).not.toHaveBeenCalled()
      expect(mockDB.updateUser).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ passwordHash: expect.any(String) }),
      )
    })

    it('should refuse an invitation that expired, was used or is unknown, and a short password', async () => {
      for (const found of [null, invite({ usedAt: new Date() }), invite({ expiresAt: new Date(Date.now() - 1) })]) {
        mockDB.findInviteByHash.mockResolvedValue(found)
        await expect(service.acceptInvite({ token: 'tok-tok-tok-tok', password: 'una-clave-larga' })).rejects.toThrow(
          InviteInvalidException,
        )
      }
      await expect(service.acceptInvite({ token: 'tok', password: 'corta' })).rejects.toThrow(WeakPasswordException)
    })
  })

  describe('Google', () => {
    const profile = { sub: 'g-1', email: 'sobrino@example.com', name: 'Sobrino' }

    it('should sign in a known user and remember their Google account', async () => {
      mockDB.findUserByGoogleSub.mockResolvedValue(null)
      mockDB.findUserByEmail.mockResolvedValue(user({ email: profile.email }))

      await service.signInWithGoogle(profile, null)

      expect(mockDB.updateUser).toHaveBeenCalledWith('u1', expect.objectContaining({ googleSub: 'g-1' }))
    })

    it('should let in an email with a pending invitation, once', async () => {
      mockDB.findUserByGoogleSub.mockResolvedValue(null)
      mockDB.findUserByEmail.mockResolvedValue(null)
      mockDB.findPendingInviteByEmail.mockResolvedValue({
        id: 'i1',
        email: profile.email,
        role: UserRole.ADMIN,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      })

      await service.signInWithGoogle(profile, null)

      expect(mockDB.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: profile.email, role: UserRole.ADMIN, googleSub: 'g-1' }),
      )
      expect(mockDB.markInviteUsed).toHaveBeenCalled()
    })

    it('should refuse a Google account nobody invited, or an invitation of another email', async () => {
      mockDB.findUserByGoogleSub.mockResolvedValue(null)
      mockDB.findUserByEmail.mockResolvedValue(null)
      mockDB.findPendingInviteByEmail.mockResolvedValue(null)
      await expect(service.signInWithGoogle(profile, null)).rejects.toThrow(NotInvitedException)

      mockDB.findInviteByHash.mockResolvedValue({
        id: 'i2',
        email: 'otro@example.com',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      })
      await expect(service.signInWithGoogle(profile, 'token-de-otro')).rejects.toThrow(NotInvitedException)
    })

    it('should not sign in a disabled user with Google either', async () => {
      mockDB.findUserByGoogleSub.mockResolvedValue(user({ status: UserStatus.DISABLED }))

      await expect(service.signInWithGoogle(profile, null)).rejects.toThrow(UserDisabledException)
    })
  })

  describe('sessions', () => {
    const found = (overrides: Record<string, unknown> = {}) => ({
      expiresAt: new Date(Date.now() + 60_000),
      impersonatedById: null,
      user: user(),
      ...overrides,
    })

    it('should know the user of a valid session, and remember it for a moment', async () => {
      mockDB.findSession.mockResolvedValue(found())

      expect((await service.validateSession('tok'))?.user.id).toBe('u1')
      await service.validateSession('tok')

      expect(mockDB.findSession).toHaveBeenCalledTimes(1)
    })

    it('should not know an expired session or a disabled user', async () => {
      mockDB.findSession.mockResolvedValue(found({ expiresAt: new Date(Date.now() - 1) }))
      expect(await service.validateSession('a')).toBeNull()

      mockDB.findSession.mockResolvedValue(found({ user: user({ status: UserStatus.DISABLED }) }))
      expect(await service.validateSession('b')).toBeNull()
    })

    it("should close a user's sessions at once when they are disabled", async () => {
      mockDB.findSession.mockResolvedValue(found())
      await service.validateSession('tok')

      await service.revokeSessionsOf('u1')
      mockDB.findSession.mockResolvedValue(null)

      expect(mockDB.deleteSessionsOf).toHaveBeenCalledWith('u1')
      expect(await service.validateSession('tok')).toBeNull()
    })
  })

  describe('the backdoor of the superadmin', () => {
    const superadmin = user({ id: 'sa', role: UserRole.SUPERADMIN })

    it('should open a short session as another user that says who is behind it', async () => {
      mockDB.findUserById.mockResolvedValue(user({ id: 'u2' }))

      const { token, expiresAt } = await service.impersonate(superadmin as never, 'u2')

      expect(mockDB.createSession).toHaveBeenCalledWith('u2', hashToken(token), expiresAt, 'sa')
      expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(4 * 60 * 60_000)
    })

    it('should not enter as oneself or as a disabled user', async () => {
      mockDB.findUserById.mockResolvedValue(superadmin)
      await expect(service.impersonate(superadmin as never, 'sa')).rejects.toThrow(ForbiddenRoleException)

      mockDB.findUserById.mockResolvedValue(user({ id: 'u2', status: UserStatus.DISABLED }))
      await expect(service.impersonate(superadmin as never, 'u2')).rejects.toThrow(ForbiddenRoleException)
    })

    it('should close the visit when the superadmin behind it is no longer one', async () => {
      mockDB.findSession.mockResolvedValue({
        expiresAt: new Date(Date.now() + 60_000),
        impersonatedById: 'sa',
        user: user({ id: 'u2' }),
      })
      mockDB.findUserById.mockResolvedValue(user({ id: 'sa', role: UserRole.ADMIN }))

      expect(await service.validateSession('visit')).toBeNull()
    })

    it('should go back to the superadmin with a session of their own', async () => {
      mockDB.findSession.mockResolvedValue({
        expiresAt: new Date(Date.now() + 60_000),
        impersonatedById: 'sa',
        user: user({ id: 'u2' }),
      })
      mockDB.findUserById.mockResolvedValue(superadmin)

      const { user: back } = await service.stopImpersonation('visit')

      expect(mockDB.deleteSession).toHaveBeenCalledWith(hashToken('visit'))
      expect(back.id).toBe('sa')
    })
  })

  describe('Telegram', () => {
    it('should give a t.me link with a code the database only keeps hashed', async () => {
      const { url } = await service.createTelegramLink('u1')

      const code = url.split('start=')[1]
      expect(url).toContain('https://t.me/kogane_bot?start=')
      expect(mockDB.createToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', tokenHash: hashToken(code) }),
      )
    })

    it('should link the chat to the user of the code, taking it from whoever had it', async () => {
      mockDB.consumeToken.mockResolvedValue({ userId: 'u1' })
      mockDB.findUserByTelegramChat.mockResolvedValue(user({ id: 'u9' }))

      await service.linkTelegram('code', '555')

      expect(mockDB.updateUser).toHaveBeenCalledWith('u9', { telegramChatId: null })
      expect(mockDB.updateUser).toHaveBeenCalledWith('u1', { telegramChatId: '555' })
    })

    it('should refuse a code that was used or expired', async () => {
      mockDB.consumeToken.mockResolvedValue(null)

      await expect(service.linkTelegram('code', '555')).rejects.toThrow(LinkCodeInvalidException)
    })

    it('should find the user of a chat: the linked one, or the owner while the allowlist still names the chat', async () => {
      mockDB.findUserByTelegramChat.mockResolvedValueOnce(user({ id: 'u3' }))
      expect((await service.userOfChat('777'))?.id).toBe('u3')

      mockDB.findUserByTelegramChat.mockResolvedValue(null)
      mockDB.findUserById.mockResolvedValue(user({ id: LEGACY_OWNER_ID }))
      expect((await service.userOfChat('555'))?.id).toBe(LEGACY_OWNER_ID)
      expect(await service.userOfChat('999')).toBeNull()
    })

    it('should not serve the chat of a disabled user', async () => {
      mockDB.findUserByTelegramChat.mockResolvedValue(user({ status: UserStatus.DISABLED }))

      expect(await service.userOfChat('777')).toBeNull()
    })

    it('should send notices to the linked chat, or to the allowlist only for the owner of the old data', async () => {
      mockDB.findUserById.mockResolvedValueOnce(user({ telegramChatId: '777' }))
      expect(await service.chatIdsOf('u1')).toEqual(['777'])

      mockDB.findUserById.mockResolvedValueOnce(user({ id: LEGACY_OWNER_ID }))
      expect(await service.chatIdsOf(LEGACY_OWNER_ID)).toEqual(['555'])

      mockDB.findUserById.mockResolvedValueOnce(user({ id: 'u2' }))
      expect(await service.chatIdsOf('u2')).toEqual([])
    })
  })

  describe('resetPassword', () => {
    it('should use up the emailed link, set the password, close the other sessions and sign in', async () => {
      mockDB.consumeToken.mockResolvedValueOnce({ userId: 'u1' })
      mockDB.findUserById.mockResolvedValueOnce(user({ passwordHash: 'old' }))

      const { user: signedIn, token } = await service.resetPassword({
        token: 'tok-1234567890',
        password: 'nueva-clave-segura',
      })

      expect(mockDB.consumeToken).toHaveBeenCalledWith('password_reset', hashToken('tok-1234567890'), expect.any(Date))
      expect(mockDB.deleteSessionsOf).toHaveBeenCalledWith('u1')
      expect(mockDB.updateUser).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ passwordHash: expect.any(String) }),
      )
      expect(mockDB.clearAttempts).toHaveBeenCalledWith('brando@example.com')
      expect(signedIn.id).toBe('u1')
      expect(token).toBeTruthy()
    })

    it('should refuse a used or unknown link and a short password', async () => {
      await expect(service.resetPassword({ token: 'tok-1234567890', password: 'corta' })).rejects.toBeInstanceOf(
        WeakPasswordException,
      )
      mockDB.consumeToken.mockResolvedValueOnce(null)
      await expect(
        service.resetPassword({ token: 'tok-1234567890', password: 'nueva-clave-segura' }),
      ).rejects.toBeInstanceOf(ResetLinkInvalidException)
    })

    it('should not reopen a disabled account', async () => {
      mockDB.consumeToken.mockResolvedValueOnce({ userId: 'u1' })
      mockDB.findUserById.mockResolvedValueOnce(user({ status: UserStatus.DISABLED }))
      await expect(
        service.resetPassword({ token: 'tok-1234567890', password: 'nueva-clave-segura' }),
      ).rejects.toBeInstanceOf(UserDisabledException)
    })
  })
})
