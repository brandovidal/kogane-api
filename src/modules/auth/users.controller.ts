import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, Res } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger'
import { Request, Response } from 'express'

import { IMPERSONATION_HOURS, SESSION_COOKIE, UserRole } from '@/commons/constants/auth.constant'
import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { RequireRole } from '@/commons/decorators/auth.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { EmptyResponseDto } from '@/commons/helpers/api-response.helper'
import { deviceOf } from '@/commons/helpers/device.helper'
import { serializeCookie } from '@/commons/helpers/token.helper'
import { AuthUser } from '@/generated/prisma/client'

import { CreateInviteDto, UpdateUserDto } from './dto/request/auth.dto'
import {
  CreatedInviteResponseDto,
  SessionUserResponseDto,
  UsersListResponseDto,
} from './dto/response/auth-response.dto'
import { AuthService, toSessionUser } from './auth.service'
import { UsersService } from './users.service'

// Configuración ▸ Usuarios (P23, D84): only admins and the superadmin
@ApiRest('users')
@RequireRole(UserRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The users and the invitations still open' })
  @ApiOkResponse({ type: UsersListResponseDto })
  @ResponseMessage('USERS_LISTED', 'Users listed')
  list() {
    return this.usersService.list()
  }

  @Post('invites')
  @ApiOperation({
    summary:
      'Invite an email: emails it when the mail is set up and returns the link either way (shown once, valid for 7 days)',
  })
  @ApiOkResponse({ type: CreatedInviteResponseDto })
  @ResponseMessage('INVITE_CREATED', 'Invitation created')
  invite(@Body() body: CreateInviteDto, @Req() req: Request & { user: AuthUser }) {
    return this.usersService.invite(body.email, body.role, req.user, body.send)
  }

  @Delete('invites/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an invitation' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('INVITE_REVOKED', 'Invitation cancelled')
  revoke(@Param('id') id: string) {
    return this.usersService.revokeInvite(id)
  }

  // The backdoor of D84: only the superadmin, for 4 hours, and the history says who was behind it
  @Post(':id/impersonate')
  @RequireRole(UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Superadmin: enter as another user for a few hours (the history records the superadmin as the actor)',
  })
  @ApiOkResponse({ type: SessionUserResponseDto })
  @ResponseMessage('IMPERSONATION_STARTED', 'Entered as the user')
  async impersonate(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.authService.impersonate(req.user, id, deviceOf(req))
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, token, {
        maxAgeSeconds: IMPERSONATION_HOURS * 60 * 60,
        secure: this.configService.get('app.env') === 'production',
      }),
    )
    return toSessionUser(user, req.user)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Give admin or member, or activate / disable (disabling closes their sessions)' })
  @ApiOkResponse({ type: SessionUserResponseDto })
  @ResponseMessage('USER_UPDATED', 'User updated')
  update(@Param('id') id: string, @Body() body: UpdateUserDto, @Req() req: Request & { user: AuthUser }) {
    return this.usersService.update(id, body, req.user)
  }
}
