import { ConfigService } from '@nestjs/config'
import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { UserStatus } from '@/commons/constants/auth.constant'
import { AuthDBRepository } from '@/db/models/auth/authDB.repository'
import { MailService } from '@/providers/mail/mail.service'

import { PasswordResetService } from './password-reset.service'

const mockDB = {
  findUserByEmail: vi.fn(),
  createToken: vi.fn(),
  recordFailedAttempt: vi.fn(),
  countFailedAttempts: vi.fn(),
}
const mockMail = { send: vi.fn(), isEnabled: true }

describe('PasswordResetService', () => {
  let service: PasswordResetService

  beforeEach(async () => {
    vi.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        { provide: AuthDBRepository, useValue: mockDB },
        { provide: MailService, useValue: mockMail },
        { provide: ConfigService, useValue: new ConfigService({ auth: { appUrl: 'https://kogane.app/' } }) },
      ],
    }).compile()
    service = module.get(PasswordResetService)
    mockDB.countFailedAttempts.mockResolvedValue(0)
    mockMail.send.mockResolvedValue(true)
  })

  it('should email a one-use link to an active account and keep only the hash of the token', async () => {
    mockDB.findUserByEmail.mockResolvedValueOnce({
      id: 'u1',
      name: 'Brando',
      email: 'brando@example.com',
      status: UserStatus.ACTIVE,
    })

    await service.request(' Brando@Example.com ')

    expect(mockDB.findUserByEmail).toHaveBeenCalledWith('brando@example.com')
    const stored = mockDB.createToken.mock.calls[0][0]
    expect(stored).toMatchObject({ kind: 'password_reset', userId: 'u1' })
    const mail = mockMail.send.mock.calls[0][0]
    expect(mail.to).toBe('brando@example.com')
    const token = /restablecer=([^\s"]+)/.exec(mail.text)?.[1]
    expect(mail.text).toContain('https://kogane.app/entrar?restablecer=')
    expect(stored.tokenHash).not.toBe(token)
  })

  it('should answer the same for an unknown or disabled email without sending anything', async () => {
    mockDB.findUserByEmail.mockResolvedValueOnce(null)
    await service.request('nadie@example.com')
    mockDB.findUserByEmail.mockResolvedValueOnce({ id: 'u2', email: 'x@example.com', status: UserStatus.DISABLED })
    await service.request('x@example.com')

    expect(mockDB.createToken).not.toHaveBeenCalled()
    expect(mockMail.send).not.toHaveBeenCalled()
  })

  it('should stop sending after 5 requests in 15 minutes for the same email', async () => {
    mockDB.countFailedAttempts.mockResolvedValueOnce(5)
    await service.request('brando@example.com')
    expect(mockDB.findUserByEmail).not.toHaveBeenCalled()
    expect(mockDB.recordFailedAttempt).not.toHaveBeenCalled()
  })
})
