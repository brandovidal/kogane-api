import { Global, Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'

import { AuthDBModule } from '@/db/models/auth/authDB.module'
import { MailModule } from '@/providers/mail/mail.module'
import { TenantInterceptor } from '@/db/tenant/tenant.interceptor'

import { AdminController } from './admin.controller'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { GoogleOAuthService } from './google-oauth.service'
import { PasswordResetService } from './password-reset.service'
import { UserProvisioningService } from './user-provisioning.service'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

// Global: SessionGuard (in every ApiRest controller) and the bot ask AuthService who someone is
@Global()
@Module({
  imports: [AuthDBModule, MailModule],
  controllers: [AuthController, UsersController, AdminController],
  providers: [
    AuthService,
    GoogleOAuthService,
    PasswordResetService,
    UsersService,
    UserProvisioningService,
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
  ],
  exports: [AuthService, UserProvisioningService, AuthDBModule],
})
export class AuthModule {}
