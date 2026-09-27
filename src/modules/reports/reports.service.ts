import { Injectable } from '@nestjs/common'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { DebtDirection, DebtStatus, DebtTiming } from '@/commons/constants/debt.constant'
import { REPORT_MIME_TYPES, ReportFormat } from '@/commons/constants/report.constant'
import { DateHelper } from '@/commons/helpers/date.helper'
import { DebtsService, DebtView, PersonDebtSummary } from '@/modules/debts/debts.service'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'

export interface ReportFile {
  filename: string
  mimeType: string
  data: Buffer
}

// Spanish labels: the files are for the user (D39)
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic']
const DIRECTION_LABELS: Record<string, string> = {
  [DebtDirection.OWED_TO_ME]: 'Me debe',
  [DebtDirection.I_OWE]: 'Le debo',
}
const STATUS_LABELS: Record<string, string> = {
  [DebtStatus.PENDING]: 'Pendiente',
  [DebtStatus.PARTIAL]: 'Abonado',
  [DebtStatus.PREPAID]: 'Amortizado',
  [DebtStatus.PAID]: 'Pagado',
}
const TIMING_LABELS: Record<string, string> = {
  [DebtTiming.UPCOMING]: 'Por venir',
  [DebtTiming.DUE]: 'Este mes',
  [DebtTiming.LATE]: 'Vencida',
}
const MONEY_FORMAT = '"S/" #,##0.00'

const money = (amount: number) =>
  `S/ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const periodOf = (debt: DebtView) => `${MONTHS[debt.paymentMonth - 1]} ${debt.paymentYear}`
const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// One expense of a month, as the export shows it (P18, /exportar): your part in soles next to what was charged
export interface ExpenseReportRow {
  date: string // YYYY-MM-DD
  description: string
  category: string | null
  method: string | null
  amount: number
  currency: string
  own: number
}

const MONTH_TITLES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Setiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
]
const NO_CATEGORY = 'Sin categoría'
const round2 = (amount: number) => Math.round(amount * 100) / 100

interface DebtReportData {
  title: string
  today: string
  summary: PersonDebtSummary[]
  detail: DebtView[]
  sourceSummary: { personId: string; person: string; source: string; direction: string; count: number; total: number }[]
}

interface ExpenseReportData {
  title: string
  rows: ExpenseReportRow[]
  categories: { name: string; total: number }[]
  total: number
}

interface DebtReportFilters {
  direction?: DebtDirection
  month?: number
  year?: number
  until?: boolean
  person?: string
  state?: DebtStatus | DebtTiming | 'open'
  card?: string
  origin?: 'shared' | 'loan'
  q?: string
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
const isPlatformCharge = (debt: DebtView) =>
  /\b(stream|streaming|plataforma|netflix|spotify|youtube|icloud|disney|hbo|max|prime video|apple tv|paramount|crunchyroll|deezer|tidal|mubi|google one|dropbox)\b/i.test(
    `${debt.description} ${debt.notes ?? ''}`,
  )
const isShared = (debt: DebtView) => /\(compartido\)$/i.test(debt.description.trim())

// Préstamos y deudas por persona (P17, D39): summary (me debe · le debo · neto) and the open installments
@Injectable()
export class ReportsService {
  constructor(
    private readonly debtsService: DebtsService,
    private readonly paymentMethods: PaymentMethodDBRepository,
  ) {}

  // Cobros / Deudas (D114): optionally one direction and one payment month, like the page on screen
  async debts(format: ReportFormat, personId?: string, filters: DebtReportFilters = {}): Promise<ReportFile> {
    const { direction, month, year, until, person, state, card, origin, q } = filters
    const detail = (
      await this.debtsService.list({
        personId: personId ?? person,
        direction,
        month,
        year,
        until,
        paymentMethodId: card,
      })
    ).filter((debt) => {
      if (debt.balance <= 0) return false
      if (q && ![debt.description, debt.notes ?? '', debt.person.name].some((text) => fold(text).includes(fold(q))))
        return false
      if (origin && isShared(debt) !== (origin === 'shared')) return false
      if (state === 'late' || state === 'due' || state === 'upcoming') return debt.timing === state
      if (state && state !== 'open' && debt.status !== state) return false
      return true
    })
    const people = new Map<string, PersonDebtSummary>()
    for (const debt of detail) {
      const row = people.get(debt.personId) ?? {
        personId: debt.personId,
        name: debt.person.name,
        owedToMe: 0,
        iOwe: 0,
        net: 0,
        late: 0,
        dueThisMonth: 0,
      }
      if (debt.direction === DebtDirection.OWED_TO_ME) {
        row.owedToMe += debt.balance
        if (debt.timing === DebtTiming.LATE) row.late += debt.balance
        if (debt.timing === DebtTiming.DUE) row.dueThisMonth += debt.balance
      } else {
        row.iOwe += debt.balance
      }
      row.net = row.owedToMe - row.iOwe
      people.set(debt.personId, row)
    }
    const summary = [...people.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    const methods = await this.paymentMethods.findAll()
    const methodNames = new Map(methods.map((method) => [method.id, method.name]))
    const sourceGroups = new Map<string, DebtReportData['sourceSummary'][number]>()
    for (const debt of detail) {
      const text = `${debt.description} ${debt.notes ?? ''}`
      const source = methodNames.get(debt.paymentMethodId ?? '')
        ? /cmr|falabella/i.test(methodNames.get(debt.paymentMethodId!)!)
          ? 'CMR (Falabella)'
          : methodNames.get(debt.paymentMethodId!)!
        : isPlatformCharge(debt)
          ? 'Plataformas · Stream'
          : /pr[eé]stamo/i.test(text)
            ? 'Préstamo'
            : debt.description
      const key = `${debt.personId}:${source}:${debt.direction}`
      const group = sourceGroups.get(key) ?? {
        personId: debt.personId,
        person: debt.person.name,
        source,
        direction: DIRECTION_LABELS[debt.direction] ?? debt.direction,
        count: 0,
        total: 0,
      }
      group.count += 1
      group.total = Math.round((group.total + debt.balance) * 100) / 100
      sourceGroups.set(key, group)
    }
    const rows = personId ? summary.filter((row) => row.personId === personId) : summary
    const name = personId ? (rows[0]?.name ?? detail[0]?.person.name ?? 'persona') : 'todas'
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    const selectedDetail = personId ? detail.filter((debt) => debt.personId === personId) : detail
    const selectedSourceSummary = [...sourceGroups.values()].filter((group) => !personId || group.personId === personId)
    const data: DebtReportData = {
      title: `Deudas · ${name}`,
      today,
      summary: rows,
      detail: selectedDetail,
      sourceSummary: selectedSourceSummary,
    }

    return {
      filename: `deudas-${slug(name)}-${today}.${format}`,
      mimeType: REPORT_MIME_TYPES[format],
      data: format === ReportFormat.XLSX ? await this.debtsXlsx(data) : await this.debtsPdf(data),
    }
  }

  // Your expenses of a month (P18, /exportar): every charge, and the total by category
  async expenses(
    format: ReportFormat,
    { month, year }: { month: number; year: number },
    rows: ExpenseReportRow[],
  ): Promise<ReportFile> {
    const byCategory = new Map<string, number>()
    for (const row of rows) {
      const name = row.category ?? NO_CATEGORY
      byCategory.set(name, round2((byCategory.get(name) ?? 0) + row.own))
    }
    const categories = [...byCategory].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total)
    const total = round2(rows.reduce((sum, row) => sum + row.own, 0))
    const title = `Gastos · ${MONTH_TITLES[month - 1]} ${year}`
    const data = { title, rows, categories, total }
    return {
      filename: `gastos-${year}-${String(month).padStart(2, '0')}.${format}`,
      mimeType: REPORT_MIME_TYPES[format],
      data: format === ReportFormat.XLSX ? await this.expensesXlsx(data) : await this.expensesPdf(data),
    }
  }

  private async expensesXlsx({ rows, categories, total }: ExpenseReportData): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Kogane'

    const detail = workbook.addWorksheet('Gastos')
    detail.columns = [
      { header: 'Fecha', key: 'date', width: 12 },
      { header: 'Concepto', key: 'description', width: 34 },
      { header: 'Categoría', key: 'category', width: 20 },
      { header: 'Medio', key: 'method', width: 18 },
      { header: 'Monto', key: 'amount', width: 13, style: { numFmt: '#,##0.00' } },
      { header: 'Moneda', key: 'currency', width: 8 },
      { header: 'Tu parte (S/)', key: 'own', width: 14, style: { numFmt: MONEY_FORMAT } },
    ]
    detail.addRows(rows.map((row) => ({ ...row, category: row.category ?? NO_CATEGORY, method: row.method ?? '' })))
    detail.addRow({ description: 'Total', own: total }).font = { bold: true }

    const summary = workbook.addWorksheet('Por categoría')
    summary.columns = [
      { header: 'Categoría', key: 'name', width: 24 },
      { header: 'Tu parte (S/)', key: 'total', width: 14, style: { numFmt: MONEY_FORMAT } },
    ]
    summary.addRows(categories)
    summary.addRow({ name: 'Total', total }).font = { bold: true }

    for (const sheet of [detail, summary]) {
      sheet.getRow(1).font = { bold: true }
      sheet.views = [{ state: 'frozen', ySplit: 1 }]
    }
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }

  private expensesPdf({ title, rows, categories, total }: ExpenseReportData): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

    doc.font('Helvetica-Bold').fontSize(16).text(title)
    doc.font('Helvetica').fontSize(9).fillColor('#666').text('Kogane · tu parte en soles').fillColor('#000')
    doc.moveDown()
    this.pdfTable(
      doc,
      ['Categoría', 'Tu parte'],
      [300, 100],
      [...categories.map((category) => [category.name, money(category.total)]), ['Total', money(total)]],
    )

    doc.moveDown().font('Helvetica-Bold').fontSize(12).text('Detalle')
    doc.moveDown(0.3)
    this.pdfTable(
      doc,
      ['Fecha', 'Concepto', 'Categoría', 'Medio', 'Tu parte'],
      [55, 160, 100, 100, 100],
      rows.map((row) => [row.date, row.description, row.category ?? NO_CATEGORY, row.method ?? '', money(row.own)]),
    )
    doc.end()
    return done
  }

  private async debtsXlsx({ summary, detail }: DebtReportData): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Kogane'

    const resumen = workbook.addWorksheet('Resumen')
    resumen.columns = [
      { header: 'Persona', key: 'name', width: 22 },
      { header: 'Me debe', key: 'owedToMe', width: 14, style: { numFmt: MONEY_FORMAT } },
      { header: 'Le debo', key: 'iOwe', width: 14, style: { numFmt: MONEY_FORMAT } },
      { header: 'Neto', key: 'net', width: 14, style: { numFmt: MONEY_FORMAT } },
      { header: 'Vencido', key: 'late', width: 14, style: { numFmt: MONEY_FORMAT } },
      { header: 'Este mes', key: 'dueThisMonth', width: 14, style: { numFmt: MONEY_FORMAT } },
    ]
    resumen.addRows(summary)
    if (summary.length > 1) {
      resumen.addRow({
        name: 'Total',
        owedToMe: summary.reduce((sum, row) => sum + row.owedToMe, 0),
        iOwe: summary.reduce((sum, row) => sum + row.iOwe, 0),
        net: summary.reduce((sum, row) => sum + row.net, 0),
        late: summary.reduce((sum, row) => sum + row.late, 0),
        dueThisMonth: summary.reduce((sum, row) => sum + row.dueThisMonth, 0),
      }).font = { bold: true }
    }

    const detalle = workbook.addWorksheet('Detalle')
    detalle.columns = [
      { header: 'Persona', key: 'person', width: 20 },
      { header: 'Tipo', key: 'direction', width: 10 },
      { header: 'Concepto', key: 'description', width: 32 },
      { header: 'Cuota', key: 'installment', width: 8 },
      { header: 'Mes de pago', key: 'period', width: 12 },
      { header: 'Monto', key: 'amount', width: 13, style: { numFmt: MONEY_FORMAT } },
      { header: 'Abonado', key: 'paid', width: 13, style: { numFmt: MONEY_FORMAT } },
      { header: 'Saldo', key: 'balance', width: 13, style: { numFmt: MONEY_FORMAT } },
      { header: 'Estado', key: 'status', width: 12 },
      { header: 'Vence', key: 'timing', width: 10 },
      { header: 'Moneda', key: 'currency', width: 8 },
    ]
    detalle.addRows(
      detail.map((debt) => ({
        person: debt.person.name,
        direction: DIRECTION_LABELS[debt.direction] ?? debt.direction,
        description: debt.description,
        installment: debt.installment ?? '',
        period: periodOf(debt),
        amount: debt.amount,
        paid: debt.paidAmount,
        balance: debt.balance,
        status: STATUS_LABELS[debt.status] ?? debt.status,
        timing: TIMING_LABELS[debt.timing] ?? debt.timing,
        currency: debt.currency,
      })),
    )

    for (const sheet of [resumen, detalle]) {
      sheet.getRow(1).font = { bold: true }
      sheet.views = [{ state: 'frozen', ySplit: 1 }]
    }
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }

  private debtsPdf({ title, today, summary, detail, sourceSummary }: DebtReportData): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

    doc.font('Helvetica-Bold').fontSize(16).text(title)
    doc.font('Helvetica').fontSize(9).fillColor('#666').text(`Kogane · ${today} · saldos en soles`).fillColor('#000')
    doc.moveDown()

    this.pdfTable(
      doc,
      ['Persona', 'Me debe', 'Le debo', 'Neto', 'Vencido'],
      [160, 85, 85, 85, 85],
      summary.map((row) => [row.name, money(row.owedToMe), money(row.iOwe), money(row.net), money(row.late)]),
    )

    doc.moveDown().font('Helvetica-Bold').fontSize(12).text('Resumen por concepto')
    doc.moveDown(0.3)
    this.pdfTable(
      doc,
      ['Persona', 'Concepto', 'Tipo', 'Registros', 'Total'],
      [115, 175, 75, 70, 75],
      sourceSummary.map((row) => [row.person, row.source, row.direction, String(row.count), money(row.total)]),
    )

    this.pdfDetailSection(
      doc,
      'Detalle de cobros · Me deben',
      detail.filter((debt) => debt.direction === DebtDirection.OWED_TO_ME),
    )
    this.pdfDetailSection(
      doc,
      'Detalle de deudas · Le debo',
      detail.filter((debt) => debt.direction === DebtDirection.I_OWE),
    )

    doc.end()
    return done
  }

  private pdfDetailSection(doc: PDFKit.PDFDocument, title: string, debts: DebtView[]) {
    doc.addPage()
    doc.font('Helvetica-Bold').fontSize(12).text(title)
    doc.moveDown(0.3)
    if (!debts.length) {
      doc.font('Helvetica').fontSize(10).text('No hay registros para los filtros seleccionados.')
      return
    }
    const byPerson = new Map<string, DebtView[]>()
    for (const debt of debts) {
      const items = byPerson.get(debt.person.name) ?? []
      items.push(debt)
      byPerson.set(debt.person.name, items)
    }
    for (const [person, items] of byPerson) {
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(10).text(person)
      this.pdfTable(
        doc,
        ['Concepto', 'Cuota', 'Mes', 'Monto', 'Abonado', 'Saldo', 'Estado'],
        [135, 38, 58, 65, 59, 68, 67],
        items.map((debt) => [
          debt.description,
          debt.installment ?? '',
          periodOf(debt),
          money(debt.amount),
          money(debt.paidAmount),
          money(debt.balance),
          debt.timing === DebtTiming.LATE ? 'Vencida' : (STATUS_LABELS[debt.status] ?? debt.status),
        ]),
      )
    }
  }

  // A plain table: bold header, one line per row, a new page (with the header again) when it does not fit
  private pdfTable(doc: PDFKit.PDFDocument, headers: string[], widths: number[], rows: string[][]) {
    const left = doc.page.margins.left
    const rowHeight = 16
    const drawRow = (cells: string[], bold: boolean) => {
      if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage()
        if (!bold) drawRow(headers, true)
      }
      const y = doc.y
      let x = left
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
      cells.forEach((cell, index) => {
        doc.text(cell, x, y, { width: widths[index] - 6, height: rowHeight, ellipsis: true, lineBreak: false })
        x += widths[index]
      })
      doc.x = left
      doc.y = y + rowHeight
    }
    drawRow(headers, true)
    rows.forEach((row) => drawRow(row, false))
  }
}
