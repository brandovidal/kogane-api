// Préstamos e inversiones (P27, D99): a commitment is a loan paid in installments, or an asset you invest in
export enum CommitmentKind {
  LOAN = 'loan', // BCP, Compartamos, the land of San Bartolo: installments are fixed costs
  INVESTMENT = 'investment', // land, property, vehicle, stocks, crypto: with installments or with contributions
}

export enum CommitmentSubtype {
  LOAN = 'loan',
  LAND = 'land',
  PROPERTY = 'property',
  VEHICLE = 'vehicle',
  STOCKS = 'stocks',
  CRYPTO = 'crypto',
  OTHER = 'other',
}

export enum CommitmentStatus {
  ACTIVE = 'active',
  PAID = 'paid', // every installment paid
  CANCELLED = 'cancelled', // cancelled early (with its cancellation amount)
}

// Attachments of any record (D100): receipts, invoices and contracts kept in R2, never in the database
export enum AttachmentKind {
  BOLETA = 'boleta',
  RECEIPT = 'recibo',
  CONTRACT = 'contrato',
  INVOICE = 'factura',
  OTHER = 'otro',
}

export enum AttachmentRefType {
  COMMITMENT = 'commitment',
  FIXED_COST = 'fixed_cost', // an installment of a loan
  CONTRIBUTION = 'contribution',
  EXPENSE = 'expense', // daily, card or subscription expense: refId is its id, area expenses/
  DEBT_PAYMENT = 'debt_payment', // the Comprobante of a cobro or debt payment: refId is the payment id, area debts/
}

// Folder of each area inside <env>/finance/ (D100)
export const ATTACHMENT_FOLDERS: Record<AttachmentRefType, string> = {
  [AttachmentRefType.COMMITMENT]: 'commitments',
  [AttachmentRefType.FIXED_COST]: 'commitments',
  [AttachmentRefType.CONTRIBUTION]: 'investments',
  [AttachmentRefType.EXPENSE]: 'expenses',
  [AttachmentRefType.DEBT_PAYMENT]: 'debts',
}

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

export const ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
] as const
