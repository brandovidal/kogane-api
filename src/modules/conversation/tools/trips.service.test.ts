import { vi } from 'vitest'

import { TripDBRepository } from '@/db/models/trip/tripDB.repository'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { TripsService } from './trips.service'

const mockTrips = { findActive: vi.fn(), start: vi.fn(), end: vi.fn(), totals: vi.fn() }
const mockExtraction = {
  loadCatalog: vi.fn().mockResolvedValue({ entries: [{ id: 'cat1', name: 'Comida', kind: 'category' }] }),
}
const trip = { id: 't1', name: 'Lima', startedAt: new Date('2026-09-20T15:00:00Z'), endedAt: null }

describe('TripsService', () => {
  const service = new TripsService(
    mockTrips as unknown as TripDBRepository,
    mockExtraction as unknown as ExpenseExtractionService,
  )

  beforeEach(() =>
    mockTrips.totals.mockResolvedValue({ total: 300, count: 4, byCategory: [{ categoryId: 'cat1', total: 300 }] }),
  )
  afterEach(() => vi.clearAllMocks())

  it('should open a trip with the name given, with a button to close it, and mention the one it closed', async () => {
    mockTrips.findActive.mockResolvedValue({ ...trip, name: 'Cusco' })

    const reply = await service.open('  Lima  ')

    expect(mockTrips.start).toHaveBeenCalledWith('Lima')
    expect(reply!.text).toContain('Viaje <b>Lima</b> abierto')
    expect(reply!.text).toContain('Cerré «Cusco»')
    expect(reply!.buttons).toEqual([[{ label: '🏁 Cerrar viaje', data: 'cmd:fin' }]])
  })

  it('should show the open trip when asked without a name, and ask for a name when there is none', async () => {
    mockTrips.findActive.mockResolvedValueOnce(trip)
    expect((await service.open(''))!.text).toContain('Viaje abierto: <b>Lima</b>')
    expect(mockTrips.start).not.toHaveBeenCalled()

    mockTrips.findActive.mockResolvedValueOnce(null)
    expect(await service.open('')).toBeNull()
  })

  it('should close the trip and add it up by category name', async () => {
    mockTrips.end.mockResolvedValue({ ...trip, endedAt: new Date('2026-09-23T15:00:00Z') })

    const { text } = await service.close()

    expect(text).toContain('cerrado · 3 días')
    expect(text).toContain('4 gastos: <b>S/ 300.00</b>')
    expect(text).toContain('Comida: S/ 300.00')
  })

  it('should say there is no trip to close', async () => {
    mockTrips.end.mockResolvedValue(null)

    expect((await service.close()).text).toContain('No hay un viaje abierto')
  })
})
