import { Person } from '@/generated/prisma/client'
import { PersonModule } from '@/commons/constants/catalog.constant'

export type PersonDbDto = Omit<Person, 'aliases' | 'appearsIn'> & { aliases: string[]; appearsIn: PersonModule[] }

export interface PersonWriteDbDto {
  name: string
  aliases?: string[]
  isDefault?: boolean
  isActive?: boolean
  documentNumber?: string | null
  appearsIn?: PersonModule[]
}
