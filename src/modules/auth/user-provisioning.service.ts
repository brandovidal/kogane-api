import { Injectable } from '@nestjs/common'

import { AuthUser } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'
import { seedBaseCatalogs } from '@/db/seed/catalog.seed'
import { runWithUser } from '@/db/tenant/tenant-context'

// What a new user starts with (D97): the budget groups and categories, and their own "Yo". No people, no cards: they
// add them in Configuración. Idempotent, so a script can run it again
@Injectable()
export class UserProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  provision(user: Pick<AuthUser, 'id' | 'name'> & Partial<Pick<AuthUser, 'documentNumber'>>): Promise<void> {
    return runWithUser(user.id, async () => {
      await seedBaseCatalogs(this.prisma, user.id)
      if (!(await this.prisma.person.findFirst({ where: { isDefault: true } }))) {
        await this.prisma.person.create({
          data: { userId: user.id, name: user.name, isDefault: true, documentNumber: user.documentNumber ?? null },
        })
      }
    })
  }

  // The DNI of the account is the one of their "Yo": it opens their bank statements (D94)
  syncOwnerDocument(userId: string, documentNumber: string | null): Promise<void> {
    return runWithUser(userId, async () => {
      await this.prisma.person.updateMany({ where: { isDefault: true }, data: { documentNumber } })
    })
  }
}
