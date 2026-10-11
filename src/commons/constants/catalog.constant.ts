export enum PaymentMethodType {
  CREDIT_CARD = 'credit_card',
  DEBIT_CARD = 'debit_card',
  WALLET = 'wallet',
  CASH = 'cash',
  BANK_TRANSFER = 'bank_transfer',
}

// Who holds a credit card (D116): the titular pays the bank; additional cards are other people's purchases on it
export enum CardHolderRole {
  TITULAR = 'titular',
  ADDITIONAL = 'additional',
}

// The pages where a person can be picked (settings ▸ Personas). Day to day is always the user and Cobros y deudas lists
// everyone, so neither is a module
export enum PersonModule {
  FIXED_COSTS = 'fixed_costs',
  PLATFORMS = 'platforms',
  CARDS = 'cards',
  RECURRING = 'recurring',
}
