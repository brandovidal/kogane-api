import { Injectable } from '@nestjs/common'

import { Attachment, StoredFile } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'
import { PaymentStatus } from '@/commons/constants/expense.constant'

export interface CreateAttachmentDbDto {
  fileId: string
  refType: string
  refId: string
  kind: string
  name: string
}

export type AttachmentWithFile = Attachment & { file: StoredFile }

// Files of any record (D100): who owns each file of bot_files
@Injectable()
export class AttachmentDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateAttachmentDbDto, markFixedCostPaid = false): Promise<AttachmentWithFile> {
    if (!markFixedCostPaid) return this.prisma.attachment.create({ data, include: { file: true } })
    // The file and payment transition are committed together. The conditional update preserves other statuses,
    // including a status changed concurrently; existing audit triggers also record this transition.
    return this.prisma.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({ data, include: { file: true } })
      await tx.fixedCost.updateMany({
        where: { id: data.refId, paymentStatus: PaymentStatus.NOT_STARTED },
        data: { paymentStatus: PaymentStatus.PAID },
      })
      return attachment
    })
  }

  findById(id: string): Promise<AttachmentWithFile | null> {
    return this.prisma.attachment.findUnique({ where: { id }, include: { file: true } })
  }

  findByRef(refType: string, refId: string): Promise<AttachmentWithFile[]> {
    return this.prisma.attachment.findMany({
      where: { refType, refId },
      include: { file: true },
      orderBy: { createdAt: 'asc' },
    })
  }

  // How many attachments each record of a type has, for the badges of the lists
  async countByRefs(refType: string, refIds: string[]): Promise<Map<string, number>> {
    if (!refIds.length) return new Map()
    const rows = await this.prisma.attachment.groupBy({
      by: ['refId'],
      where: { refType, refId: { in: refIds } },
      _count: { _all: true },
    })
    return new Map(rows.map((row) => [row.refId, row._count._all]))
  }

  async delete(id: string): Promise<void> {
    await this.prisma.attachment.delete({ where: { id } })
  }

  // A record was deleted: its attachments go with it. Returns the files to release from the bucket
  async deleteByRefs(refTypes: string[], refId: string): Promise<string[]> {
    const where = { refType: { in: refTypes }, refId }
    const rows = await this.prisma.attachment.findMany({ where, select: { fileId: true } })
    await this.prisma.attachment.deleteMany({ where })
    return rows.map((row) => row.fileId)
  }
}
