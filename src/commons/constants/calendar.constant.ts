// Payment calendar (P20, D89): what is due or closes each day, computed from the expense tables (no table of its own)
export enum CalendarEventKind {
  CARD_CLOSE = 'card_close', // a card closes its statement
  CARD_DUE = 'card_due', // a card statement has to be paid
  FIXED_COST = 'fixed_cost',
  SUBSCRIPTION = 'subscription',
  DEBT_OWED_TO_ME = 'debt_owed_to_me', // an installment someone owes the user
  DEBT_I_OWE = 'debt_i_owe', // an installment the user owes
  RECURRING = 'recurring', // a recurring expense not generated yet for that month
}

export enum CalendarEventStatus {
  PENDING = 'pending',
  PAID = 'paid',
  LATE = 'late', // its day already passed and it is not paid
}

// Events are listed for at most this many days in one request
export const MAX_CALENDAR_DAYS = 100
export const DEFAULT_INSTALLMENT_MONTHS = 3
export const MAX_INSTALLMENT_MONTHS = 12

// ✅ Pagado from the bot or the web calendar (POST /v1/calendar/pay)
export enum PaymentOutcome {
  PAID = 'paid',
  ALREADY_PAID = 'already_paid',
  NOTHING_TO_PAY = 'nothing_to_pay', // a card statement without unpaid rows
  NOT_FOUND = 'not_found', // deleted after the reminder, or not something that can be paid
  PARTIAL = 'partial', // a card statement paid in part: it stays open for what is left
}

// How a payment registered from the calendar was made (the "Medio de pago" of the dialog)
export enum PayMethod {
  TRANSFER = 'transfer',
  CASH = 'cash',
  WALLET = 'wallet',
  DEBIT_CARD = 'debit_card',
  OTHER = 'other',
}

// What a payment covers: everything left, the minimum of a card statement, or any other amount
export enum PaymentKind {
  TOTAL = 'total',
  MINIMUM = 'minimum',
  PARTIAL = 'partial',
}
