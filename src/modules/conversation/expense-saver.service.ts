import { Injectable, Logger } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { DEBT_DIRECTION_BY_DESTINATION, DebtDirection } from '@/commons/constants/debt.constant'
import {
  Currency,
  ExpenseDestination,
  ExpenseType,
  INSTALLMENT_REGEX,
  PaymentStatus,
  SubscriptionKind,
} from '@/commons/constants/expense.constant'
import { DateHelper } from '@/commons/helpers/date.helper'
import {
  addMonths,
  creditCardPaymentPeriod,
  PaymentPeriod,
  paymentPeriodOf,
} from '@/commons/helpers/payment-period.helper'
import { ExpenseNotSaveableException } from '@/commons/exceptions/conversation/expense-not-saveable.exception'
import { ExpenseDraftDbDto } from '@/db/models/expense-draft/expenseDraftDB.dto'
import { BudgetSettingDBRepository, subscriptionCounts } from '@/db/models/budget-setting/budgetSettingDB.repository'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { SaveExpenseDbDto } from '@/db/models/expense/expenseDB.dto'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { TripDBRepository } from '@/db/models/trip/tripDB.repository'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { BudgetImpact, InstallmentsCreated, SavedExpense } from './dto/conversation.types'
import { sharesOf } from './shared-expense.parser'

// The destinations a trip tags: what is spent day to day and with a card
const TRIP_DESTINATIONS: string[] = [ExpenseDestination.DAILY, ExpenseDestination.CREDIT_CARD]

function withTrip(input: SaveExpenseDbDto, tripId: string | null): SaveExpenseDbDto {
  if (!tripId || !TRIP_DESTINATIONS.includes(input.destination)) return input
  if (input.destination === ExpenseDestination.CREDIT_CARD) {
    return {
      ...input,
      data: { ...input.data, tripId },
      nextInstallments: input.nextInstallments.map((row) => ({ ...row, tripId })),
    }
  }
  return { ...input, data: { ...input.data, tripId } } as SaveExpenseDbDto
}

// One row per installment (debts D60, credit cards D66): "1/n" creates the n installments, one per month; "3/6"
// only that one (the others were registered before). The amount is always the installment's.
function withInstallments<T extends Record<string, unknown>>(
  base: T,
  installment: string | null,
  period: PaymentPeriod,
) {
  const valid = installment && INSTALLMENT_REGEX.test(installment) ? installment : null
  const [current, total] = valid ? valid.split('/').map(Number) : [0, 0]
  const data = { ...base, installment: valid, ...period }
  const nextInstallments =
    current === 1 && total > 1
      ? Array.from({ length: total - 1 }, (_, index) => ({
          ...data,
          installment: `${index + 2}/${total}`,
          ...addMonths(period, index + 1),
        }))
      : []
  return { data, nextInstallments }
}

// Destinations whose amount can be shared (D73): the row keeps the total the user paid, othersShare what the others owe
// and each one gets a debt; debts themselves cannot be shared
const SHAREABLE_DESTINATIONS: string[] = [
  ExpenseDestination.DAILY,
  ExpenseDestination.FIXED_COST,
  ExpenseDestination.SUBSCRIPTION,
  ExpenseDestination.CREDIT_CARD,
]

type Row = Record<string, unknown> & { amount: number }

// Rows created with the draft besides its own (installments after the first, shared parts) point to it, so /editar
// can replace them all (D76)
function withOrigin(input: SaveExpenseDbDto, draftId: string): SaveExpenseDbDto {
  if (!('nextInstallments' in input) || !input.nextInstallments.length) return input
  return {
    ...input,
    nextInstallments: input.nextInstallments.map((row) => ({ ...row, originDraftId: draftId })),
  } as SaveExpenseDbDto
}

// The user paid it all (D73): every row keeps its amount and othersShare; each person owes their part of each row
// (one debt per person and per installment, in the payment month of that row)
function withSharedDebts(input: SaveExpenseDbDto, expenseDraft: ExpenseDraftDbDto): SaveExpenseDbDto {
  const { sharedWith, destination } = expenseDraft
  if (!sharedWith?.shares.length || !destination || !SHAREABLE_DESTINATIONS.includes(destination)) return input

  const rows: Row[] = [input.data as Row, ...(('nextInstallments' in input ? input.nextInstallments : []) as Row[])]
  const periodOf = (row: Row): PaymentPeriod =>
    input.destination === ExpenseDestination.DAILY
      ? paymentPeriodOf(new Date(row.spentAt as Date).toISOString().slice(0, 10))
      : { paymentMonth: row.paymentMonth as number, paymentYear: row.paymentYear as number }
  const withShare = (row: Row) => ({ ...row, othersShare: sharesOf(row.amount, sharedWith).othersShare })

  const sharedDebts = rows.flatMap((row) =>
    sharesOf(row.amount, sharedWith)
      .parts.filter((part) => part.amount > 0)
      .map((part) => ({
        direction: DebtDirection.OWED_TO_ME,
        description: `${expenseDraft.description} (compartido)`,
        amount: part.amount,
        currency: expenseDraft.currency ?? Currency.PEN,
        personId: part.personId,
        installment: (row.installment as string | null | undefined) ?? null,
        // the card (or account) the user paid it with: Cobros contrasts it with the statement (D114)
        paymentMethodId: (row.paymentMethodId as string | null | undefined) ?? null,
        originDraftId: expenseDraft.id,
        ...periodOf(row),
      })),
  )
  return {
    ...input,
    data: withShare(input.data as Row),
    ...('nextInstallments' in input ? { nextInstallments: (input.nextInstallments as Row[]).map(withShare) } : {}),
    sharedDebts,
  } as SaveExpenseDbDto
}

// What the user pays of a row: the total minus what others owe of it (D73)
const ownAmount = (data: { amount: number; othersShare?: number }) =>
  Math.round((data.amount - (data.othersShare ?? 0)) * 100) / 100

// Debts are not spending; a subscription counts only when bud_settings switches its kind on and no credit card paid
// it (D46, D96, D107). Only PEN, your part
function budgetImpact(input: SaveExpenseDbDto, subscriptionCounts: boolean): BudgetImpact | null {
  const { destination, data } = input
  if ((data.currency ?? Currency.PEN) !== Currency.PEN) return null
  switch (destination) {
    case ExpenseDestination.DAILY:
      return {
        personId: data.personId,
        categoryId: data.categoryId ?? null,
        period: paymentPeriodOf(new Date(data.spentAt).toISOString().slice(0, 10)),
        amount: ownAmount(data),
      }
    case ExpenseDestination.SUBSCRIPTION:
      if (!subscriptionCounts) return null
      return {
        personId: data.personId,
        categoryId: data.categoryId ?? null,
        period: { paymentMonth: data.paymentMonth, paymentYear: data.paymentYear },
        amount: ownAmount(data),
      }
    case ExpenseDestination.FIXED_COST:
    case ExpenseDestination.CREDIT_CARD:
      return {
        personId: data.personId,
        categoryId: data.categoryId ?? null,
        period: { paymentMonth: data.paymentMonth, paymentYear: data.paymentYear },
        amount: ownAmount(data),
      }
    default:
      return null
  }
}

function installmentsCreated(input: SaveExpenseDbDto): InstallmentsCreated | null {
  if (!('nextInstallments' in input) || !input.nextInstallments.length) return null
  const last = input.nextInstallments[input.nextInstallments.length - 1]
  return {
    total: input.nextInstallments.length + 1,
    from: { paymentMonth: input.data.paymentMonth, paymentYear: input.data.paymentYear },
    to: { paymentMonth: last.paymentMonth, paymentYear: last.paymentYear },
  }
}

// Turns a confirmed ExpenseDraft into a record of its destination table (✅ Guardar)
@Injectable()
export class ExpenseSaverService {
  private readonly logger = new Logger(ExpenseSaverService.name)

  constructor(
    private readonly expenseDBRepository: ExpenseDBRepository,
    private readonly paymentMethodDBRepository: PaymentMethodDBRepository,
    private readonly storedFilesService: StoredFilesService,
    private readonly budgetSettingDBRepository: BudgetSettingDBRepository,
    private readonly tripDBRepository: TripDBRepository,
  ) {}

  async save(expenseDraft: ExpenseDraftDbDto): Promise<SavedExpense> {
    this.assertComplete(expenseDraft)

    // Day-to-day and card expenses saved while a trip is open belong to it (/viaje, P18)
    const trip = await this.tripDBRepository.findActive()
    const input = withTrip(
      withSharedDebts(withOrigin(await this.buildInput(expenseDraft), expenseDraft.id), expenseDraft),
      trip?.id ?? null,
    )
    const saved = await this.expenseDBRepository.saveFromExpenseDraft(
      expenseDraft.id,
      input,
      expenseDraft.replacesDraftId ?? undefined,
    )
    await this.keepFile(expenseDraft.fileId)
    return {
      ...saved,
      installments: installmentsCreated(input),
      trip: trip && TRIP_DESTINATIONS.includes(input.destination) ? trip.name : null,
      budget: budgetImpact(input, await this.subscriptionCounts(input)),
    }
  }

  private async subscriptionCounts(input: SaveExpenseDbDto): Promise<boolean> {
    if (input.destination !== ExpenseDestination.SUBSCRIPTION) return false
    const { kind, paymentMethodId } = input.data as { kind?: string; paymentMethodId?: string | null }
    const [settings, method] = await Promise.all([
      this.budgetSettingDBRepository.get(),
      paymentMethodId ? this.paymentMethodDBRepository.findById(paymentMethodId) : Promise.resolve(null),
    ])
    return subscriptionCounts(settings, kind ?? SubscriptionKind.PLATFORM, method?.type)
  }

  // The screenshot of a saved expense moves out of drafts (D58). The expense is already saved: a failure only logs
  private async keepFile(fileId: string | null) {
    if (!fileId) return
    try {
      await this.storedFilesService.keep(fileId)
    } catch (error) {
      this.logger.warn(`[keepFile] file ${fileId} not kept: ${(error as Error).message}`)
    }
  }

  private assertComplete({ id, missingFields, destination, description, amount, personId }: ExpenseDraftDbDto) {
    if (missingFields.length || !destination || !description || amount == null || !personId) {
      throw new ExpenseNotSaveableException({ draftId: id, missingFields })
    }
  }

  private async buildInput(expenseDraft: ExpenseDraftDbDto): Promise<SaveExpenseDbDto> {
    const { destination } = expenseDraft
    const description = expenseDraft.description as string
    // A shared expense keeps the total the user paid (D73); the others' parts become debts (withSharedDebts)
    const amount = expenseDraft.amount as number
    const personId = expenseDraft.personId as string

    const currency = expenseDraft.currency ?? Currency.PEN
    const spentAt = expenseDraft.spentAt ?? new Date(`${DateHelper.todayIn(APP_TIME_ZONE)}T00:00:00.000Z`)
    const spentAtIso = spentAt.toISOString().slice(0, 10)

    const base = {
      description,
      amount,
      currency,
      exchangeRate: expenseDraft.exchangeRate,
      amountInPen: currency === Currency.PEN ? amount : null,
      personId,
      notes: expenseDraft.notes,
    }
    const expense = {
      ...base,
      expenseType: expenseDraft.expenseType ?? ExpenseType.ESSENTIAL,
      categoryId: expenseDraft.categoryId,
      installment: expenseDraft.installment,
    }

    switch (destination) {
      case ExpenseDestination.DAILY:
        return {
          destination,
          data: {
            ...base,
            expenseType: expenseDraft.expenseType ?? ExpenseType.ESSENTIAL,
            paymentMethodId: this.required(expenseDraft, expenseDraft.paymentMethodId),
            categoryId: expenseDraft.categoryId,
            spentAt,
            merchant: expenseDraft.merchant,
            operationNumber: expenseDraft.operationNumber,
          },
        }
      case ExpenseDestination.FIXED_COST:
        return {
          destination,
          data: {
            ...expense,
            categoryId: this.required(expenseDraft, expenseDraft.categoryId),
            paymentMethodId: expenseDraft.paymentMethodId,
            paymentStatus: PaymentStatus.NOT_STARTED,
            paymentDate: spentAt,
            ...paymentPeriodOf(spentAtIso),
          },
        }
      case ExpenseDestination.SUBSCRIPTION:
        return {
          destination,
          data: {
            ...expense,
            period: this.required(expenseDraft, expenseDraft.period),
            kind: expenseDraft.kind ?? SubscriptionKind.PLATFORM,
            supplyNumber: expenseDraft.supplyNumber,
            paymentMethodId: expenseDraft.paymentMethodId,
            paymentStatus: PaymentStatus.NOT_STARTED,
            paymentDate: spentAt,
            ...paymentPeriodOf(spentAtIso),
          },
        }
      case ExpenseDestination.CREDIT_CARD: {
        const paymentMethodId = this.required(expenseDraft, expenseDraft.paymentMethodId)
        const card = this.required(expenseDraft, await this.paymentMethodDBRepository.findById(paymentMethodId))
        // A card without closing day (e.g. just created from the bot) is billed in the month of the purchase
        const period = card.billingCloseDay
          ? creditCardPaymentPeriod(spentAtIso, card.billingCloseDay)
          : paymentPeriodOf(spentAtIso)
        const data = { ...expense, paymentMethodId, paymentStatus: PaymentStatus.NOT_STARTED, processDate: spentAt }
        return { destination, ...withInstallments(data, expenseDraft.installment, period) }
      }
      case ExpenseDestination.RECEIVABLE:
      case ExpenseDestination.PAYABLE: {
        const direction = DEBT_DIRECTION_BY_DESTINATION[destination] as DebtDirection
        return this.buildDebt(
          expenseDraft,
          destination,
          { ...base, direction },
          await this.debtPeriod(expenseDraft, spentAtIso),
        )
      }
      default:
        throw new ExpenseNotSaveableException({ draftId: expenseDraft.id, destination })
    }
  }

  // One row per installment (D60)
  private buildDebt(
    expenseDraft: ExpenseDraftDbDto,
    destination: ExpenseDestination.RECEIVABLE | ExpenseDestination.PAYABLE,
    base: { direction: DebtDirection; description: string; amount: number; personId: string } & Record<string, unknown>,
    period: PaymentPeriod,
  ): SaveExpenseDbDto {
    return { destination, ...withInstallments(base, expenseDraft.installment, period) }
  }

  // Something bought with a credit card for someone is paid back in the card's billing month (D22); otherwise now
  private async debtPeriod(expenseDraft: ExpenseDraftDbDto, spentAtIso: string): Promise<PaymentPeriod> {
    if (!expenseDraft.paymentMethodId) return paymentPeriodOf(spentAtIso)
    const method = await this.paymentMethodDBRepository.findById(expenseDraft.paymentMethodId)
    return method?.type === PaymentMethodType.CREDIT_CARD && method.billingCloseDay
      ? creditCardPaymentPeriod(spentAtIso, method.billingCloseDay)
      : paymentPeriodOf(spentAtIso)
  }

  private required<T>(expenseDraft: ExpenseDraftDbDto, value: T | null | undefined): T {
    if (value == null) {
      throw new ExpenseNotSaveableException({ draftId: expenseDraft.id })
    }
    return value
  }
}
