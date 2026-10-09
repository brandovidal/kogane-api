import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ApiOkResponse, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { Request, Response } from 'express'

import { OAUTH_STATE_COOKIE, SESSION_COOKIE, SESSION_DAYS } from '@/commons/constants/auth.constant'
import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { Public } from '@/commons/decorators/auth.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { EmptyResponseDto } from '@/commons/helpers/api-response.helper'
import { parseCookies, serializeCookie } from '@/commons/helpers/token.helper'
import { AuthUser } from '@/generated/prisma/client'
import { MailService } from '@/providers/mail/mail.service'
import { AuthConfig } from '@/settings/settings.model'

import { AuthService, toSessionUser } from './auth.service'
import {
  AcceptInviteDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  GoogleCallbackQueryDto,
  GoogleStartQueryDto,
  LoginDto,
  ResetPasswordDto,
} from './dto/request/auth.dto'
import {
  AuthConfigResponseDto,
  GoogleStartResponseDto,
  InvitePreviewResponseDto,
  SessionUserResponseDto,
  TelegramLinkResponseDto,
} from './dto/response/auth-response.dto'
import { GoogleOAuthService } from './google-oauth.service'
import { PasswordResetService } from './password-reset.service'

const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60
type AuthedRequest = Request & { user: AuthUser }

// Sign in, out and who I am (P23, D82–D85). The session is an httpOnly cookie that the proxy of the web forwards and
// returns; the web calls these through `/api/v1/auth/*`
@ApiRest('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  private get secure(): boolean {
    return this.configService.get('app.env') === 'production'
  }

  private setSession(res: Response, token: string) {
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_SECONDS, secure: this.secure }),
    )
  }

  @Public()
  @Get('config')
  @ApiOperation({ summary: 'What the sign-in page offers (Google only when it is set up)' })
  @ApiOkResponse({ type: AuthConfigResponseDto })
  @ResponseMessage('AUTH_CONFIG', 'Sign-in options')
  config() {
    return { google: this.googleOAuthService.isEnabled, mail: this.mailService.isEnabled }
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with email or mobile and password (5 failures lock that identifier for 15 minutes)',
  })
  @ApiOkResponse({ type: SessionUserResponseDto })
  @ResponseMessage('LOGIN_OK', 'Signed in')
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { user, token } = await this.authService.login(body.identifier, body.password)
    this.setSession(res, token)
    return toSessionUser(user)
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out: the session is deleted and the cookie cleared' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('LOGOUT_OK', 'Signed out')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (token) await this.authService.logout(token)
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: this.secure }))
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user (401 SESSION_REQUIRED without a session)' })
  @ApiOkResponse({ type: SessionUserResponseDto })
  @ResponseMessage('ME', 'Current user')
  me(@Req() req: AuthedRequest & { impersonatedBy: AuthUser | null }) {
    return toSessionUser(req.user, req.impersonatedBy)
  }

  @Post('impersonation/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A superadmin who entered as another user goes back to their own account' })
  @ApiOkResponse({ type: SessionUserResponseDto })
  @ResponseMessage('IMPERSONATION_STOPPED', 'Back to your account')
  async stopImpersonation(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, token } = await this.authService.stopImpersonation(
      parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '',
    )
    this.setSession(res, token)
    return toSessionUser(user)
  }

  @Public()
  @Get('invite/:token')
  @ApiOperation({ summary: 'Whose invitation it is (410 INVITE_INVALID when it expired or was used)' })
  @ApiOkResponse({ type: InvitePreviewResponseDto })
  @ResponseMessage('INVITE_FOUND', 'Invitation found')
  invite(@Param('token') token: string) {
    return this.authService.previewInvite(token)
  }

  @Public()
  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open an invitation with a password: the email is proven by the link; they are signed in' })
  @ApiOkResponse({ type: SessionUserResponseDto })
  @ResponseMessage('INVITE_ACCEPTED', 'Invitation accepted')
  async acceptInvite(@Body() body: AcceptInviteDto, @Res({ passthrough: true }) res: Response) {
    const { user, token } = await this.authService.acceptInvite(body)
    this.setSession(res, token)
    return toSessionUser(user)
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '"¿Olvidaste tu contraseña?": emails a one-use link (60 minutes). Same answer whether the email exists or not',
  })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('PASSWORD_RESET_REQUESTED', 'If the email has an account, a link was sent')
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    await this.passwordResetService.request(body.email)
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Choose a new password with the emailed link (410 RESET_LINK_INVALID); other sessions are closed',
  })
  @ApiOkResponse({ type: SessionUserResponseDto })
  @ResponseMessage('PASSWORD_RESET', 'Password changed')
  async resetPassword(@Body() body: ResetPasswordDto, @Res({ passthrough: true }) res: Response) {
    const { user, token } = await this.authService.resetPassword(body)
    this.setSession(res, token)
    return toSessionUser(user)
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set or change the password (the current one is required when there is one)' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('PASSWORD_CHANGED', 'Password saved')
  async password(@Body() body: ChangePasswordDto, @Req() req: AuthedRequest) {
    await this.authService.changePassword(req.user.id, body.current, body.next)
  }

  // ==================== Google ====================

  @Public()
  @Get('google')
  @ApiOperation({ summary: 'Where to send the browser to sign in with Google (keeps a state cookie, one use)' })
  @ApiOkResponse({ type: GoogleStartResponseDto })
  @ResponseMessage('GOOGLE_STARTED', 'Google sign-in started')
  async google(@Query() query: GoogleStartQueryDto, @Res({ passthrough: true }) res: Response) {
    const { url, state } = await this.googleOAuthService.start(query.returnTo, query.invite)
    res.append('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, state, { maxAgeSeconds: 600, secure: this.secure }))
    return { url }
  }

  @Get('google/link')
  @ApiOperation({ summary: 'Start linking Google to the signed-in account; the Google email must match' })
  @ApiOkResponse({ type: GoogleStartResponseDto })
  @ResponseMessage('GOOGLE_LINK_STARTED', 'Google account linking started')
  async googleLink(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const { url, state } = await this.googleOAuthService.start('/perfil', undefined, req.user.id)
    res.append('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, state, { maxAgeSeconds: 600, secure: this.secure }))
    return { url }
  }

  @Public()
  @Get('google/callback')
  @ApiOperation({ summary: 'Where Google sends the browser back: signs in and redirects to the web (a browser route)' })
  @ApiResponse({ status: 302, description: 'Redirect to the web: the page asked for, or /entrar?error=…' })
  async googleCallback(@Query() query: GoogleCallbackQueryDto, @Req() req: Request, @Res() res: Response) {
    const appUrl = this.configService.getOrThrow<AuthConfig>('auth').appUrl.replace(/\/$/, '')
    res.append('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, '', { maxAgeSeconds: 0, secure: this.secure }))
    if (query.error || !query.code || !query.state) {
      const state = query.state
        ? await this.googleOAuthService.cancel(query.state, parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE])
        : null
      return res.redirect(
        state?.linkUserId ? `${appUrl}/perfil?google_error=cancelled` : `${appUrl}/entrar?error=google`,
      )
    }
    let linking = false
    try {
      const { profile, state } = await this.googleOAuthService.finish(
        query.code,
        query.state,
        parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE],
      )
      if (state.linkUserId) {
        linking = true
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
        const session = token ? await this.authService.validateSession(token) : null
        if (!session || session.user.id !== state.linkUserId) throw new Error('Google link session expired')
        await this.authService.linkGoogleAccount(state.linkUserId, profile)
        return res.redirect(`${appUrl}/perfil?google=linked`)
      }
      const { token } = await this.authService.signInWithGoogle(profile, state.invite)
      this.setSession(res, token)
      return res.redirect(`${appUrl}${state.returnTo}`)
    } catch (error) {
      const code = (error as { getResponse?: () => { code?: string } }).getResponse?.().code
      if (linking) {
        const reason =
          code === 'GOOGLE_EMAIL_MISMATCH' ? 'email' : code === 'GOOGLE_ALREADY_LINKED' ? 'linked' : 'session'
        return res.redirect(`${appUrl}/perfil?google_error=${reason}`)
      }
      return res.redirect(`${appUrl}/entrar?error=${code === 'USER_DISABLED' ? 'desactivado' : 'no_invitado'}`)
    }
  }

  // ==================== Telegram ====================

  @Post('telegram-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A t.me link that links a Telegram chat to this user (15 minutes, one use)' })
  @ApiOkResponse({ type: TelegramLinkResponseDto })
  @ResponseMessage('TELEGRAM_LINK_CREATED', 'Link created')
  telegramLink(@Req() req: AuthedRequest) {
    return this.authService.createTelegramLink(req.user.id)
  }

  @Delete('telegram')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlink the Telegram chat of this user' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('TELEGRAM_UNLINKED', 'Telegram unlinked')
  async unlinkTelegram(@Req() req: AuthedRequest) {
    await this.authService.unlinkTelegram(req.user.id)
  }
}
