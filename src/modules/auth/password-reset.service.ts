import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import {
  AuthTokenKind,
  LOGIN_LOCK_MINUTES,
  MAX_LOGIN_ATTEMPTS,
  PASSWORD_RESET_MINUTES,
  UserStatus,
} from '@/commons/constants/auth.constant'
import { generateToken, hashToken } from '@/commons/helpers/token.helper'
import { AuthDBRepository } from '@/db/models/auth/authDB.repository'
import { MailService } from '@/providers/mail/mail.service'
import { AuthConfig } from '@/settings/settings.model'

import { passwordResetEmail } from './password-reset-email'

// "¿Olvidaste tu contraseña?": a one-use link by email. The answer never says whether the email has an account, and
// requests are throttled per email like the sign-in (the same attempts table, with its own key)
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly authDBRepository: AuthDBRepository,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  get isEnabled(): boolean {
    return this.mailService.isEnabled
  }

  async request(email: string): Promise<void> {
    const key = `reset:${email.trim().toLowerCase()}`
    const since = new Date(Date.now() - LOGIN_LOCK_MINUTES * 60_000)
    if ((await this.authDBRepository.countFailedAttempts(key, since)) >= MAX_LOGIN_ATTEMPTS) return
    await this.authDBRepository.recordFailedAttempt(key)

    const user = await this.authDBRepository.findUserByEmail(email.trim().toLowerCase())
    if (!user || user.status === UserStatus.DISABLED) return

    const token = generateToken()
    await this.authDBRepository.createToken({
      kind: AuthTokenKind.PASSWORD_RESET,
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_MINUTES * 60_000),
    })
    await this.mailService.send(
      passwordResetEmail({
        to: user.email,
        name: user.name,
        url: this.resetUrl(token),
        minutes: PASSWORD_RESET_MINUTES,
      }),
    )
  }

  resetUrl(token: string): string {
    const { appUrl } = this.configService.getOrThrow<AuthConfig>('auth')
    return `${appUrl.replace(/\/$/, '')}/entrar?restablecer=${token}`
  }
}
