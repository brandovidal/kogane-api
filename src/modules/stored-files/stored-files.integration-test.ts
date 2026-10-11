import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Test, TestingModule } from '@nestjs/testing'

import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { RecurringTargetType } from '@/commons/constants/expense.constant'
import {
  ExpenseDraftChannel,
  ExpenseDraftInputType,
  ExpenseDraftStatus,
} from '@/commons/constants/expense-draft.constant'
import { StoredFileStatus } from '@/commons/constants/stored-file.constant'
import { StoredFileExpiredException } from '@/commons/exceptions/stored-file/stored-file-expired.exception'
import { ExpenseRecordDBModule } from '@/db/models/expense-record/expenseRecordDB.module'
import { ExpenseRecordDBRepository, ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'
import { PrismaModule } from '@/db/prisma/prisma.module'
import { PrismaService } from '@/db/prisma/prisma.service'
import { SettingsModule } from '@/settings/settings.module'

import { StoredFilesModule } from './stored-files.module'
import { StoredFilesService } from './stored-files.service'

const DAY_MS = 24 * 60 * 60_000
const onDisk = (key: string) => join(process.cwd(), process.env.STORAGE_LOCAL_DIR ?? '.data/storage', key)

// Temporary files end to end on SQLite + the local folder: the database keeps where the bytes are, never the bytes
describe('StoredFilesService (integration)', () => {
  let moduleRef: TestingModule
  let service: StoredFilesService
  let prisma: PrismaService
  let expenseRecords: ExpenseRecordDBRepository
  let fileCount = 0

  // Unique bytes per test: the same bytes would reuse a file stored by another test
  const newImage = () => Buffer.from(`stored-files-integration-${Date.now()}-${++fileCount}`)

  const createDraft = (fileId: string, status: ExpenseDraftStatus, messageId = `m-${++fileCount}`) =>
    prisma.expenseDraft.create({
      data: {
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: 'stored-files-chat',
        messageId,
        inputType: ExpenseDraftInputType.IMAGE,
        status,
        fileId,
      },
    })

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [SettingsModule, PrismaModule, StoredFilesModule, ExpenseRecordDBModule],
    }).compile()
    await moduleRef.init()

    service = moduleRef.get(StoredFilesService)
    prisma = moduleRef.get(PrismaService)
    expenseRecords = moduleRef.get(ExpenseRecordDBRepository)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  it('should store a temporary file under test/finance/drafts/ with only its key and metadata in the database', async () => {
    const data = newImage()

    const file = await service.storeTemporary(ExpenseDraftChannel.WEB, data, 'image/png')

    expect(file).toMatchObject({
      channel: ExpenseDraftChannel.WEB,
      contentType: 'image/png',
      sizeBytes: data.length,
      status: StoredFileStatus.TEMPORARY,
    })
    expect(file.storageKey).toMatch(/^test\/finance\/drafts\/\d{4}-\d{2}\/[0-9a-f-]{36}\.png$/)
    expect(file.expiresAt!.getTime() - file.createdAt.getTime()).toBeCloseTo(7 * DAY_MS, -4)
    expect(readFileSync(onDisk(file.storageKey))).toEqual(data)
    await expect(service.download(file.id)).resolves.toEqual({
      mimeType: 'image/png',
      data: data.toString('base64'),
    })

    // No column holds the bytes
    const row = JSON.stringify(await prisma.storedFile.findUniqueOrThrow({ where: { id: file.id } }))
    expect(row).not.toContain(data.toString('base64'))
    expect(row).not.toContain(data.toString())
  })

  it('should reuse the stored file when the same bytes arrive again', async () => {
    const data = newImage()

    const first = await service.storeTemporary(ExpenseDraftChannel.TELEGRAM, data, 'image/jpeg')
    const second = await service.storeTemporary(ExpenseDraftChannel.WEB, data, 'image/jpeg')

    expect(second.id).toBe(first.id)
    expect(await prisma.storedFile.count({ where: { sha256: first.sha256 } })).toBe(1)
  })

  it('should move a kept file to test/finance/expenses/<yyyy>/<mm>/ and never expire it', async () => {
    const file = await service.storeTemporary(ExpenseDraftChannel.TELEGRAM, newImage(), 'image/jpeg')
    const [, , , month, name] = file.storageKey.split('/')

    await service.keep(file.id)

    const kept = await prisma.storedFile.findUniqueOrThrow({ where: { id: file.id } })
    expect(kept).toMatchObject({
      status: StoredFileStatus.KEPT,
      storageKey: `test/finance/expenses/${month.replace('-', '/')}/${name}`,
      expiresAt: null,
    })
    expect(kept.keptAt).not.toBeNull()
    expect(existsSync(onDisk(kept.storageKey))).toBe(true)
    expect(existsSync(onDisk(file.storageKey))).toBe(false)

    // A year later the cleanup leaves it alone
    await service.deleteExpired(new Date(Date.now() + 365 * DAY_MS))
    expect(existsSync(onDisk(kept.storageKey))).toBe(true)
  })

  it('should delete expired temporary files, keep the row as history and fail later reads', async () => {
    const file = await service.storeTemporary(ExpenseDraftChannel.TELEGRAM, newImage(), 'audio/ogg')

    // Not yet: 6 days later it is still there
    await service.deleteExpired(new Date(Date.now() + 6 * DAY_MS))
    expect(existsSync(onDisk(file.storageKey))).toBe(true)

    await service.deleteExpired(new Date(Date.now() + 8 * DAY_MS))

    const deleted = await prisma.storedFile.findUniqueOrThrow({ where: { id: file.id } })
    expect(deleted.status).toBe(StoredFileStatus.DELETED)
    expect(deleted.deletedAt).not.toBeNull()
    expect(existsSync(onDisk(file.storageKey))).toBe(false)
    await expect(service.download(file.id)).rejects.toThrow(StoredFileExpiredException)
    await expect(service.signedUrl(file.id)).resolves.toBeNull()
  })

  it('should release the file of a deleted expense only once nothing else uses it', async () => {
    const person = await prisma.person.create({ data: { name: `Stored Files Person ${Date.now()}` } })
    const method = await prisma.paymentMethod.create({
      data: { name: `Stored Files Yape ${Date.now()}`, type: PaymentMethodType.WALLET },
    })
    const file = await service.storeTemporary(ExpenseDraftChannel.TELEGRAM, newImage(), 'image/jpeg')

    // One screenshot, two expenses: one saved, the other discarded for now
    const savedDraft = await createDraft(file.id, ExpenseDraftStatus.SAVED)
    const otherDraft = await createDraft(file.id, ExpenseDraftStatus.DISCARDED)
    const expense = await prisma.dailyExpense.create({
      data: {
        description: 'Yape',
        amount: 18,
        spentAt: new Date(),
        personId: person.id,
        paymentMethodId: method.id,
        draftId: savedDraft.id,
      },
    })
    await service.keep(file.id)
    const { storageKey } = await prisma.storedFile.findUniqueOrThrow({ where: { id: file.id } })
    const setOtherDraft = (status: ExpenseDraftStatus) =>
      prisma.expenseDraft.update({ where: { id: otherDraft.id }, data: { status } })

    // The saved expense still exists
    await expect(service.release(file.id)).resolves.toBe(false)

    // Expense deleted, but the other draft is back under review
    const { fileId } = await expenseRecords.delete(ExpenseResource.DAILY, expense.id)
    expect(fileId).toBe(file.id)
    await setOtherDraft(ExpenseDraftStatus.PENDING_REVIEW)
    await expect(service.release(file.id)).resolves.toBe(false)
    expect(existsSync(onDisk(storageKey))).toBe(true)

    // Discarded again: nobody uses it anymore
    await setOtherDraft(ExpenseDraftStatus.DISCARDED)
    await expect(service.release(file.id)).resolves.toBe(true)

    expect((await prisma.storedFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe(
      StoredFileStatus.DELETED,
    )
    expect(existsSync(onDisk(storageKey))).toBe(false)

    // Test catalogs out: the conversation flows replay AI answers that point to catalog refs by position
    await prisma.paymentMethod.delete({ where: { id: method.id } })
    await prisma.person.delete({ where: { id: person.id } })
  })

  it('should report no file for a recurring expense (not created from drafts)', async () => {
    const person = await prisma.person.create({ data: { name: `Recurring Person ${Date.now()}` } })
    const recurring = await prisma.recurringExpense.create({
      data: {
        description: 'Gimnasio',
        amount: 99,
        personId: person.id,
        targetType: RecurringTargetType.FIXED_COST,
        dayOfMonth: 5,
      },
    })

    await expect(expenseRecords.delete(ExpenseResource.RECURRING, recurring.id)).resolves.toEqual({ fileId: null })
    await prisma.person.delete({ where: { id: person.id } })
  })
})
