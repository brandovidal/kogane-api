import { createZodDto } from 'nestjs-zod'

import {
  acceptInviteSchema,
  changePasswordSchema,
  createSuperadminSchema,
  createInviteSchema,
  forgotPasswordSchema,
  googleCallbackQuerySchema,
  googleStartQuerySchema,
  loginSchema,
  resetPasswordSchema,
  updateUserSchema,
} from '../../validations/auth.validation'

export class CreateSuperadminDto extends createZodDto(createSuperadminSchema) {}
export class LoginDto extends createZodDto(loginSchema) {}
export class AcceptInviteDto extends createZodDto(acceptInviteSchema) {}
export class GoogleStartQueryDto extends createZodDto(googleStartQuerySchema) {}
export class GoogleCallbackQueryDto extends createZodDto(googleCallbackQuerySchema) {}
export class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
export class CreateInviteDto extends createZodDto(createInviteSchema) {}
export class UpdateUserDto extends createZodDto(updateUserSchema) {}
