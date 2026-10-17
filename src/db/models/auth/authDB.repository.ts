import { Injectable } from '@nestjs/common'

import { AuthInvite, AuthSession, AuthToken, AuthUser } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'

export type CreateUserDbDto = Pick<AuthUser, 'name' | 'email'> &
  Partial<
    Pick<AuthUser, 'googleSub' | 'passwordHash' | 'role' | 'status' | 'telegramChatId' | 'phone' | 'documentNumber'>
  >

// The users, their sessions, invitations, one-use codes and failed attempts (P23). None of these tables has a userId:
// they are what says who the user is
@Injectable()
export class AuthDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ==================== Users ====================

  findUserById(id: string): Promise<AuthUser | null> {
    return this.prisma.authUser.findUnique({ where: { id } })
  }

  findUserByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.authUser.findUnique({ where: { email: email.trim().toLowerCase() } })
  }

  findUserByGoogleSub(googleSub: string): Promise<AuthUser | null> {
    return this.prisma.authUser.findUnique({ where: { googleSub } })
  }

  findUserByPhone(phone: string): Promise<AuthUser | null> {
    return this.prisma.authUser.findUnique({ where: { phone } })
  }

  findUserByTelegramChat(chatId: string): Promise<AuthUser | null> {
    return this.prisma.authUser.findUnique({ where: { telegramChatId: chatId } })
  }

  listUsers(): Promise<AuthUser[]> {
    return this.prisma.authUser.findMany({ orderBy: [{ createdAt: 'asc' }] })
  }

  countUsers(): Promise<number> {
    return this.prisma.authUser.count()
  }

  createUser(data: CreateUserDbDto): Promise<AuthUser> {
    return this.prisma.authUser.create({ data: { ...data, email: data.email.trim().toLowerCase() } })
  }

  updateUser(id: string, data: Partial<Omit<AuthUser, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AuthUser> {
    return this.prisma.authUser.update({
      where: { id },
      data: { ...data, ...(data.email ? { email: data.email.trim().toLowerCase() } : {}) },
    })
  }

  // ==================== Sessions ====================

  createSession(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    impersonatedById: string | null = null,
    device: { userAgent: string | null; ipAddress: string | null } | null = null,
  ): Promise<AuthSession> {
    return this.prisma.authSession.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        impersonatedById,
        userAgent: device?.userAgent ?? null,
        ipAddress: device?.ipAddress ?? null,
      },
    })
  }

  // The sessions that are still open, the most recently used first (Perfil ▸ Dispositivos)
  listSessionsOf(userId: string, now: Date): Promise<AuthSession[]> {
    return this.prisma.authSession.findMany({
      where: { userId, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
    })
  }

  // Revokes sessions of this user only (ids of someone else's are ignored); returns the hashes that were deleted so the
  // memory of the service can forget them. `ids` omitted = every session of the user; `exceptHash` keeps one
  async deleteSessionsWhere(userId: string, options: { ids?: string[]; exceptHash?: string } = {}): Promise<string[]> {
    const where = {
      userId,
      ...(options.ids ? { id: { in: options.ids } } : {}),
      ...(options.exceptHash ? { tokenHash: { not: options.exceptHash } } : {}),
    }
    const found = await this.prisma.authSession.findMany({ where, select: { id: true, tokenHash: true } })
    if (!found.length) return []
    await this.prisma.authSession.deleteMany({ where: { id: { in: found.map((session) => session.id) } } })
    return found.map((session) => session.tokenHash)
  }

  findSession(tokenHash: string): Promise<(AuthSession & { user: AuthUser }) | null> {
    return this.prisma.authSession.findUnique({ where: { tokenHash }, include: { user: true } })
  }

  async touchSession(id: string, lastSeenAt: Date): Promise<void> {
    await this.prisma.authSession.update({ where: { id }, data: { lastSeenAt } })
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { tokenHash } })
  }

  async deleteSessionsOf(userId: string): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { userId } })
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { expiresAt: { lt: now } } })
  }

  // ==================== Invitations ====================

  createInvite(data: { email: string; role: string; tokenHash: string; invitedById: string | null; expiresAt: Date }) {
    return this.prisma.authInvite.create({ data: { ...data, email: data.email.trim().toLowerCase() } })
  }

  findInviteByHash(tokenHash: string): Promise<AuthInvite | null> {
    return this.prisma.authInvite.findUnique({ where: { tokenHash } })
  }

  // The pending invitation of an email (the newest one), for who signs in with Google without opening the link
  findPendingInviteByEmail(email: string, now: Date): Promise<AuthInvite | null> {
    return this.prisma.authInvite.findFirst({
      where: { email: email.trim().toLowerCase(), usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    })
  }

  listPendingInvites(now: Date): Promise<AuthInvite[]> {
    return this.prisma.authInvite.findMany({
      where: { usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    })
  }

  async markInviteUsed(id: string, usedAt: Date): Promise<void> {
    await this.prisma.authInvite.update({ where: { id }, data: { usedAt } })
  }

  async deleteInvite(id: string): Promise<void> {
    await this.prisma.authInvite.deleteMany({ where: { id } })
  }

  // ==================== One-use codes (Telegram link, Google state) ====================

  createToken(data: { kind: string; userId?: string | null; tokenHash: string; payload?: unknown; expiresAt: Date }) {
    return this.prisma.authToken.create({
      data: {
        kind: data.kind,
        userId: data.userId ?? null,
        tokenHash: data.tokenHash,
        payload: data.payload === undefined ? null : JSON.stringify(data.payload),
        expiresAt: data.expiresAt,
      },
    })
  }

  // Takes the code: it works once (the update only matches while it is unused and not expired)
  async consumeToken(kind: string, tokenHash: string, now: Date): Promise<AuthToken | null> {
    const token = await this.prisma.authToken.findFirst({
      where: { kind, tokenHash, usedAt: null, expiresAt: { gt: now } },
    })
    if (!token) return null
    const { count } = await this.prisma.authToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: now },
    })
    return count === 1 ? token : null
  }

  // ==================== Failed sign-ins ====================

  async recordFailedAttempt(email: string): Promise<void> {
    await this.prisma.authAttempt.create({ data: { email: email.trim().toLowerCase() } })
  }

  countFailedAttempts(email: string, since: Date): Promise<number> {
    return this.prisma.authAttempt.count({ where: { email: email.trim().toLowerCase(), createdAt: { gte: since } } })
  }

  async clearAttempts(email: string): Promise<void> {
    await this.prisma.authAttempt.deleteMany({ where: { email: email.trim().toLowerCase() } })
  }
}
