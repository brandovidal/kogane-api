import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { PersonModule } from '@/commons/constants/catalog.constant'
import { PrismaService } from '@/db/prisma/prisma.service'

import { PersonDBRepository } from './personDB.repository'
import { PersonDBSerializer } from './personDB.serializer'

const mockPrismaService = {
  person: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}

describe('PersonDBRepository', () => {
  let repository: PersonDBRepository

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PersonDBRepository, PersonDBSerializer, { provide: PrismaService, useValue: mockPrismaService }],
    }).compile()

    repository = module.get<PersonDBRepository>(PersonDBRepository)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should return active people with their aliases parsed', async () => {
    mockPrismaService.person.findMany.mockResolvedValue([
      { id: 'p1', name: 'Danery', aliases: '["dany","mi esposa"]', isActive: true },
    ])

    const people = await repository.findActive()

    expect(mockPrismaService.person.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    })
    expect(people[0].aliases).toEqual(['dany', 'mi esposa'])
  })

  it('should keep the owner and the people marked for a page when asked for that page', async () => {
    mockPrismaService.person.findMany.mockResolvedValue([
      { id: 'me', name: 'Brando', aliases: '[]', isDefault: true, appearsIn: '[]' },
      { id: 'p1', name: 'Danery', aliases: '[]', isDefault: false, appearsIn: '["cards","fixed_costs"]' },
      { id: 'p2', name: 'Abel', aliases: '[]', isDefault: false, appearsIn: '["recurring"]' },
      { id: 'p3', name: 'Dora', aliases: '[]', isDefault: false, appearsIn: '["unknown"]' },
    ])

    expect((await repository.findAll(PersonModule.CARDS)).map((person) => person.name)).toEqual(['Brando', 'Danery'])
    expect((await repository.findAll()).map((person) => person.name)).toHaveLength(4)
  })

  it('should store the pages once, and every page for the owner', async () => {
    mockPrismaService.$transaction.mockImplementation((fn) => fn(mockPrismaService))
    mockPrismaService.person.create.mockResolvedValue({ id: 'p1', aliases: '[]', appearsIn: '[]' })

    await repository.create({ name: 'Danery', appearsIn: [PersonModule.CARDS, PersonModule.CARDS] })
    await repository.create({ name: 'Yo', isDefault: true, appearsIn: [PersonModule.CARDS] })

    expect(mockPrismaService.person.create.mock.calls[0][0].data.appearsIn).toBe('["cards"]')
    expect(JSON.parse(mockPrismaService.person.create.mock.calls[1][0].data.appearsIn)).toEqual(
      Object.values(PersonModule),
    )
  })
})
