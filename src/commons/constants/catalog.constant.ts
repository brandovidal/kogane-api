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

// Cuentas de salida: where the money leaves from when something is paid (a catalog, no balance)
export enum AccountType {
  BANK_ACCOUNT = 'bank_account',
  WALLET = 'wallet', // Yape, Plin, Lemon…
  CASH = 'cash',
}
