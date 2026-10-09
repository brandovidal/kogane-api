import { SubscriptionPeriod } from '@/commons/constants/expense.constant'

import { templateFromRow } from './recurring.helper'

describe('templateFromRow', () => {
  it('should repeat a fixed cost monthly on the day of its due date, its month already generated', () => {
    expect(
      templateFromRow(
        {
          description: 'Internet',
          amount: 99,
          currency: 'PEN',
          personId: 'me',
          categoryId: 'cat1',
          paymentMethodId: null,
          dueDate: new Date('2026-10-12T00:00:00Z'),
          paymentMonth: 10,
          paymentYear: 2026,
          expenseType: 'essential',
        },
        'fixed_cost',
      ),
    ).toEqual({
      description: 'Internet',
      amount: 99,
      currency: 'PEN',
      targetType: 'fixed_cost',
      kind: 'platform',
      period: SubscriptionPeriod.MONTHLY,
      supplyNumber: null,
      expenseType: 'essential',
      personId: 'me',
      categoryId: 'cat1',
      paymentMethodId: null,
      dayOfMonth: 12,
      isActive: true,
      lastGeneratedAt: new Date('2026-10-01T00:00:00Z'),
    })
  })

  it('should keep the kind, period and supply number of a subscription, and default to the 1st without a date', () => {
    const template = templateFromRow(
      {
        description: 'Enel',
        amount: 80,
        personId: 'me',
        kind: 'service',
        period: SubscriptionPeriod.QUARTERLY,
        supplyNumber: '123',
        paymentMonth: 9,
        paymentYear: 2026,
      },
      'subscription',
    )
    expect(template).toMatchObject({
      targetType: 'subscription',
      kind: 'service',
      period: SubscriptionPeriod.QUARTERLY,
      supplyNumber: '123',
      dayOfMonth: 1,
      currency: 'PEN',
    })
  })
})
