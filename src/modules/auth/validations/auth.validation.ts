import { z } from 'zod'

import { MIN_PASSWORD_LENGTH, UserRole, UserStatus } from '@/commons/constants/auth.constant'
import { dateTimeSchema } from '@/commons/helpers/api-response.helper'

const email = z.string().trim().toLowerCase().pipe(z.email())
const password = z.string().min(MIN_PASSWORD_LENGTH).max(200)

export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(120).describe('The email, or the mobile an admin registered (9 digits)'),
  password: z.string().min(1).max(200),
})

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  name: z.string().trim().min(1).max(80).optional().describe('Their name; the part of the email before @ by default'),
  password,
})

export const forgotPasswordSchema = z.object({
  email: email.describe('The email of the account; the answer is the same whether it exists or not'),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(10).describe('The token of the emailed link (?restablecer=…)'),
  password,
})

export const googleStartQuerySchema = z.object({
  returnTo: z.string().optional().describe('A path of the web to go back to after signing in'),
  invite: z.string().optional().describe('The token of an invitation, when they came from its link'),
})

export const googleCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
})

export const changePasswordSchema = z.object({
  current: z.string().max(200).optional().describe('Required when the account already has a password'),
  next: password,
})

export const createInviteSchema = z.object({
  email,
  role: z.enum([UserRole.ADMIN, UserRole.MEMBER]).default(UserRole.MEMBER),
  send: z.boolean().default(true).describe('Also email the invitation (only when the mail is set up)'),
})

export const updateUserSchema = z
  .object({
    role: z.enum([UserRole.ADMIN, UserRole.MEMBER]).optional(),
    status: z.enum([UserStatus.ACTIVE, UserStatus.DISABLED]).optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined)

// ==================== Responses (Swagger / kogane-app types) ====================

export const sessionUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: z.enum(UserRole),
  status: z.enum(UserStatus),
  hasPassword: z.boolean(),
  googleLinked: z.boolean(),
  telegramLinked: z.boolean(),
  lastLoginAt: dateTimeSchema.nullable(),
  impersonatedBy: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .describe('A superadmin who entered as this user (the backdoor): the web shows a banner to go back'),
})

// The backdoor without a shell (D84): needs the x-admin-key of ADMIN_BOOTSTRAP_KEY
export const createSuperadminSchema = z.object({
  email,
  name: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(20).optional(),
  documentNumber: z
    .string()
    .trim()
    .regex(/^\d{8}$/)
    .optional()
    .describe('DNI: goes to their Yo (D94), never back in the clear'),
})

export const superadminCreatedSchema = z.object({
  user: sessionUserSchema,
  url: z.string().describe('The link to define a password (7 days, one use); Google needs nothing'),
})

export const authConfigSchema = z.object({
  google: z.boolean().describe('Google sign-in is set up'),
  mail: z.boolean().describe('Invitations and password reset links can be emailed'),
})

export const invitePreviewSchema = z.object({ email: z.string(), role: z.enum(UserRole) })

export const googleStartSchema = z.object({ url: z.string().describe('Where to send the browser to sign in') })

export const telegramLinkSchema = z.object({
  url: z.string().describe('t.me link that opens the bot with the code'),
  expiresAt: dateTimeSchema,
})

export const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(UserRole),
  expiresAt: dateTimeSchema,
  createdAt: dateTimeSchema,
})

export const createdInviteSchema = inviteSchema.extend({
  url: z.string().describe('The link to hand over: shown once, only its hash is kept'),
  emailed: z.boolean().describe('The invitation went out by email too'),
})

export const usersListSchema = z.object({ users: z.array(sessionUserSchema), invites: z.array(inviteSchema) })
