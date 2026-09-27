import PDFDocument from 'pdfkit'

import { StatementPasswordException } from '@/commons/exceptions/statement/statement-password.exception'
import { StatementUnreadableException } from '@/commons/exceptions/statement/statement-unreadable.exception'

import { readPdfLines } from './statement-pdf.reader'

// A statement PDF protected with a document number, like the banks send them (D94)
function protectedPdf(password: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ userPassword: password, ownerPassword: 'owner' })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.fontSize(10).text('ESTADO DE CUENTA SIP', 50, 50)
    doc.text('15/08 MP*MERCADOLI 1/3', 50, 80)
    doc.text('164.90', 400, 80)
    doc.end()
  })
}

// A "SOLES … DÓLARES" table (IO's Abonos / Consumos directos / Consumos en cuotas): each row's amount has no inline
// symbol, only its X position under one of the two headers says which currency it is
function twoColumnPdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument()
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.fontSize(10)
    doc.text('FECHA DESCRIPCION', 50, 50)
    doc.text('SOLES', 300, 50)
    doc.text('DOLARES', 400, 50)
    doc.text('20-SEP CINEPLANET', 50, 80)
    doc.text('23.00', 300, 80)
    doc.text('23-SEP RAILWAY', 50, 110)
    doc.text('5.00', 400, 110)
    doc.text('24-SEP ALREADY MARKED', 50, 140)
    doc.text('US$', 350, 140)
    doc.text('7.00', 420, 140)
    doc.end()
  })
}

describe('readPdfLines', () => {
  it('should open a protected PDF with the document number and join each printed line', async () => {
    const lines = await readPdfLines(await protectedPdf('44556677'), '44556677')
    expect(lines).toEqual(['ESTADO DE CUENTA SIP', '15/08 MP*MERCADOLI 1/3 164.90'])
  })

  it('should mark the currency of a row from its X position under the SOLES or DÓLARES header', async () => {
    const lines = await readPdfLines(await twoColumnPdf(), null)
    expect(lines).toEqual([
      'FECHA DESCRIPCION SOLES DOLARES',
      '20-SEP CINEPLANET S/ 23.00',
      '23-SEP RAILWAY US$ 5.00',
      // Already has its own symbol: not marked twice
      '24-SEP ALREADY MARKED US$ 7.00',
    ])
  })

  it('should say when the password is missing or wrong', async () => {
    const pdf = await protectedPdf('44556677')
    await expect(readPdfLines(pdf, null)).rejects.toMatchObject({
      constructor: StatementPasswordException,
      response: expect.objectContaining({ details: { reason: 'missing' } }),
    })
    await expect(readPdfLines(pdf, '00000000')).rejects.toMatchObject({
      response: expect.objectContaining({ details: { reason: 'incorrect' } }),
    })
  })

  it('should refuse something that is not a PDF', async () => {
    await expect(readPdfLines(Buffer.from('hola'), null)).rejects.toBeInstanceOf(StatementUnreadableException)
  })
})
