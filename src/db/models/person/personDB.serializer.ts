import { Injectable } from '@nestjs/common'

import { Person } from '@/generated/prisma/client'
import { PersonModule } from '@/commons/constants/catalog.constant'
import { JsonHelper } from '@/commons/helpers/json.helper'

import { PersonDbDto } from './personDB.dto'

@Injectable()
export class PersonDBSerializer {
  toDto(person: Person): PersonDbDto {
    return {
      ...person,
      aliases: JsonHelper.parseArray(person.aliases),
      appearsIn: JsonHelper.parseArray(person.appearsIn).filter((value): value is PersonModule =>
        Object.values(PersonModule).includes(value as PersonModule),
      ),
    }
  }

  toDtoArray(people: Person[]): PersonDbDto[] {
    return people.map((person) => this.toDto(person))
  }
}
