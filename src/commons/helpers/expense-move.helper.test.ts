import { PaymentStatus, SubscriptionKind, SubscriptionPeriod } from '@/commons/constants/expense.constant'

import { convertRow, copyRow, rowsFrom } from './expense-move.helper'

const due = new Date('2026-09-05T00:00:00.000Z')
const attention = new Date('2026-09-03T00:00:00.000Z')

describe('convertRow (D106)', () => {
  it('should turn a fixed cost into a monthly service, keeping id, draft, importKey and share', () => {
    const fixedCost = {
      id: 'fc-1',
      description: 'Bitel Papa',
      amount: 29.9,
      othersShare: 10,
      draftId: 'draft-1',
      importKey: 'notion:abc#1',
      categoryId: 'personal',
      paymentStatus: PaymentStatus.DEPOSITED,
      dueDate: null,
      attentionDate: attention,
    }

    expect(convertRow(fixedCost, 'fixedCost', 'subscription', { kind: SubscriptionKind.SERVICE })).toEqual({
      id: 'fc-1',
      description: 'Bitel Papa',
      amount: 29.9,
      othersShare: 10,
      draftId: 'draft-1',
      importKey: 'notion:abc#1',
      categoryId: 'personal',
      paymentStatus: PaymentStatus.PAID,
      dueDate: attention,
      period: SubscriptionPeriod.MONTHLY,
      kind: SubscriptionKind.SERVICE,
    })
  })

  it('should keep the due date it had and map a partial payment to pending', () => {
    const row = { id: 'fc-2', dueDate: due, attentionDate: attention, paymentStatus: PaymentStatus.PARTIALLY_PAID }

    expect(convertRow(row, 'fixedCost', 'subscription', { kind: SubscriptionKind.OTHER })).toEqual(
      expect.objectContaining({ dueDate: due, paymentStatus: PaymentStatus.PENDING }),
    )
  })

  it('should drop period, kind and supply number when a subscription becomes a fixed cost', () => {
    const subscription = {
      id: 'sub-1',
      categoryId: null,
      period: SubscriptionPeriod.MONTHLY,
      kind: SubscriptionKind.SERVICE,
      supplyNumber: '123',
      paymentStatus: PaymentStatus.PAID,
    }

    expect(convertRow(subscription, 'subscription', 'fixedCost', { categoryId: 'home' })).toEqual({
      id: 'sub-1',
      categoryId: 'home',
      paymentStatus: PaymentStatus.PAID,
    })
  })

  it('should leave the category out of an import update without one, so the row keeps its own', () => {
    expect(convertRow({ id: 'sub-2', categoryId: null, period: 'monthly' }, 'subscription', 'fixedCost')).toEqual({
      id: 'sub-2',
    })
  })

  it('should only change the kind from Plataformas to Recurrentes, keeping the period', () => {
    const platform = { id: 'sub-3', period: SubscriptionPeriod.ANNUAL, kind: SubscriptionKind.PLATFORM }

    expect(convertRow(platform, 'subscription', 'subscription', { kind: SubscriptionKind.ANNUAL })).toEqual({
      id: 'sub-3',
      period: SubscriptionPeriod.ANNUAL,
      kind: SubscriptionKind.ANNUAL,
    })
  })

  describe('copyRow', () => {
    it('should write a new unpaid row without id, draft, Notion key or shares, keeping description, amount and month', () => {
      const copy = copyRow(
        {
          id: 'fc1',
          userId: 'u1',
          description: 'Netflix',
          amount: 44.9,
          othersShare: 22.45,
          paymentStatus: PaymentStatus.PAID,
          paymentDate: new Date('2026-09-05'),
          paymentMonth: 9,
          paymentYear: 2026,
          draftId: 'd1',
          importKey: 'k1',
          attentionDate: null,
          commitmentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        'fixedCost',
        'subscription',
        { kind: SubscriptionKind.PLATFORM },
      )

      expect(copy).toEqual(
        expect.objectContaining({
          description: 'Netflix',
          amount: 44.9,
          othersShare: 0,
          paymentStatus: PaymentStatus.NOT_STARTED,
          paymentDate: null,
          paymentMonth: 9,
          paymentYear: 2026,
          kind: SubscriptionKind.PLATFORM,
          period: SubscriptionPeriod.MONTHLY,
        }),
      )
      for (const column of ['id', 'userId', 'draftId', 'importKey', 'createdAt', 'updatedAt', 'commitmentId']) {
        expect(copy).not.toHaveProperty(column)
      }
    })
  })

  describe('rowsFrom', () => {
    const rows = [
      { paymentMonth: 11, paymentYear: 2025 },
      { paymentMonth: 1, paymentYear: 2026 },
      { paymentMonth: 2, paymentYear: 2026 },
    ]

    it('should keep the rows from that payment month on, crossing years', () => {
      expect(rowsFrom(rows, { month: 1, year: 2026 })).toEqual(rows.slice(1))
      expect(rowsFrom(rows, null)).toEqual(rows)
    })
  })
})
