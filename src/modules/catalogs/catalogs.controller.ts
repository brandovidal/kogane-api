import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common'
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger'

import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { PaymentMethodIncompleteException } from '@/commons/exceptions/catalog/payment-method-incomplete.exception'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { BudgetGroupDBRepository } from '@/db/models/budget-group/budgetGroupDB.repository'
import { CategoryDBRepository } from '@/db/models/category/categoryDB.repository'
import { CardHolderDBRepository } from '@/db/models/card-holder/cardHolderDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'

import {
  BudgetGroupListResponseDto,
  BudgetGroupResponseDto,
  CategoryListResponseDto,
  CategoryResponseDto,
  CardHolderListResponseDto,
  PaymentMethodListResponseDto,
  PaymentMethodResponseDto,
  PersonListResponseDto,
  PersonResponseDto,
} from './dto/response/catalogs-response.dto'
import {
  CreateBudgetGroupDto,
  CreateCategoryDto,
  CardHoldersDto,
  StatementPasswordDto,
  CreatePaymentMethodDto,
  CreatePersonDto,
  UpdateBudgetGroupDto,
  UpdateCategoryDto,
  UpdatePaymentMethodDto,
  UpdatePersonDto,
} from './dto/request/catalogs.dto'
import { missingCardFields } from './validations/catalogs.validation'

// What a card needs to be saved (D97): an edit of one of these checks the whole card again
const CARD_FIELDS = ['type', 'code', 'bank', 'billingCloseDay', 'paymentDueDay']

// Catalogs for kogane-app (P7). The bot reads the same tables: changes apply to the AI prompt right away.

// The document number opens the bank statement PDFs (D94): the web only sees its last 3 characters
const maskDocument = <T extends { documentNumber: string | null }>(person: T): T => ({
  ...person,
  documentNumber: person.documentNumber ? `•••••${person.documentNumber.slice(-3)}` : null,
})

@ApiRest('catalogs')
@Controller('people')
export class PeopleController {
  constructor(private readonly personDBRepository: PersonDBRepository) {}

  @Get()
  @ApiOperation({ summary: 'People (active and inactive)' })
  @ApiOkResponse({ type: PersonListResponseDto })
  @ResponseMessage('PEOPLE_LISTED', 'People listed')
  async findAll() {
    return (await this.personDBRepository.findAll()).map(maskDocument)
  }

  @Post()
  @ApiOperation({ summary: 'Add a person; isDefault clears the previous default' })
  @ApiOkResponse({ type: PersonResponseDto })
  @ResponseMessage('PERSON_CREATED', 'Person created')
  async create(@Body() body: CreatePersonDto) {
    return maskDocument(await this.personDBRepository.create(body))
  }

  @Patch(':id')
  @ApiOkResponse({ type: PersonResponseDto })
  @ResponseMessage('PERSON_UPDATED', 'Person updated')
  async update(@Param('id') id: string, @Body() body: UpdatePersonDto) {
    return maskDocument(await this.personDBRepository.update(id, body))
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate a person (expenses keep pointing to it)' })
  @ApiOkResponse({ type: PersonResponseDto })
  @ResponseMessage('PERSON_DEACTIVATED', 'Person deactivated')
  async deactivate(@Param('id') id: string) {
    return maskDocument(await this.personDBRepository.deactivate(id))
  }
}

@ApiRest('catalogs')
@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(
    private readonly paymentMethodDBRepository: PaymentMethodDBRepository,
    private readonly cardHolderDBRepository: CardHolderDBRepository,
  ) {}

  @Get(':id/holders')
  @ApiOperation({ summary: 'Titular and additional people of a credit card (D116)' })
  @ApiOkResponse({ type: CardHolderListResponseDto })
  @ResponseMessage('CARD_HOLDERS_LISTED', 'Card holders listed')
  holders(@Param('id') id: string) {
    return this.cardHolderDBRepository.findByCard(id)
  }

  @Put(':id/holders')
  @ApiOperation({ summary: 'Replace the titular and additional people of a credit card; statements assign by them' })
  @ApiOkResponse({ type: CardHolderListResponseDto })
  @ResponseMessage('CARD_HOLDERS_SAVED', 'Card holders saved')
  saveHolders(@Param('id') id: string, @Body() { holders }: CardHoldersDto) {
    return this.cardHolderDBRepository.replace(id, holders)
  }

  @Put(':id/statement-password')
  @ApiOperation({
    summary:
      'Save or remove (null) the password of the statement PDFs of a card (I12); only hasStatementPassword is answered',
  })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ResponseMessage('STATEMENT_PASSWORD_SAVED', 'Statement password saved')
  saveStatementPassword(@Param('id') id: string, @Body() { password }: StatementPasswordDto) {
    return this.paymentMethodDBRepository.setStatementPassword(id, password)
  }

  @Get()
  @ApiOperation({ summary: 'Payment methods (credit cards included, with their billing days)' })
  @ApiOkResponse({ type: PaymentMethodListResponseDto })
  @ResponseMessage('PAYMENT_METHODS_LISTED', 'Payment methods listed')
  findAll() {
    return this.paymentMethodDBRepository.findAll()
  }

  @Post()
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ResponseMessage('PAYMENT_METHOD_CREATED', 'Payment method created')
  create(@Body() body: CreatePaymentMethodDto) {
    return this.paymentMethodDBRepository.createFull(body)
  }

  @Patch(':id')
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ResponseMessage('PAYMENT_METHOD_UPDATED', 'Payment method updated')
  async update(@Param('id') id: string, @Body() body: UpdatePaymentMethodDto) {
    // Only when the change touches what a card needs (D97): cards made by the bot may lack their days until edited
    if (CARD_FIELDS.some((field) => field in body)) {
      const current = await this.paymentMethodDBRepository.findById(id)
      const missing = current ? missingCardFields({ ...current, ...body }) : []
      if (missing.length) throw new PaymentMethodIncompleteException({ missing })
    }
    return this.paymentMethodDBRepository.update(id, body)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate a payment method (expenses keep pointing to it)' })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ResponseMessage('PAYMENT_METHOD_DEACTIVATED', 'Payment method deactivated')
  deactivate(@Param('id') id: string) {
    return this.paymentMethodDBRepository.deactivate(id)
  }
}

@ApiRest('catalogs')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoryDBRepository: CategoryDBRepository) {}

  @Get()
  @ApiOkResponse({ type: CategoryListResponseDto })
  @ResponseMessage('CATEGORIES_LISTED', 'Categories listed')
  findAll() {
    return this.categoryDBRepository.findAll()
  }

  @Post()
  @ApiOkResponse({ type: CategoryResponseDto })
  @ResponseMessage('CATEGORY_CREATED', 'Category created')
  create(@Body() body: CreateCategoryDto) {
    return this.categoryDBRepository.create(body)
  }

  @Patch(':id')
  @ApiOkResponse({ type: CategoryResponseDto })
  @ResponseMessage('CATEGORY_UPDATED', 'Category updated')
  update(@Param('id') id: string, @Body() body: UpdateCategoryDto) {
    return this.categoryDBRepository.update(id, body)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category (409 CATALOG_ITEM_IN_USE while expenses use it)' })
  delete(@Param('id') id: string) {
    return this.categoryDBRepository.delete(id)
  }
}

@ApiRest('catalogs')
@Controller('budget-groups')
export class BudgetGroupsController {
  constructor(private readonly budgetGroupDBRepository: BudgetGroupDBRepository) {}

  @Get()
  @ApiOperation({ summary: 'Budget groups (Relación de gastos) with their share of the income' })
  @ApiOkResponse({ type: BudgetGroupListResponseDto })
  @ResponseMessage('BUDGET_GROUPS_LISTED', 'Budget groups listed')
  findAll() {
    return this.budgetGroupDBRepository.findAll()
  }

  @Post()
  @ApiOkResponse({ type: BudgetGroupResponseDto })
  @ResponseMessage('BUDGET_GROUP_CREATED', 'Budget group created')
  create(@Body() body: CreateBudgetGroupDto) {
    return this.budgetGroupDBRepository.create(body)
  }

  @Patch(':id')
  @ApiOkResponse({ type: BudgetGroupResponseDto })
  @ResponseMessage('BUDGET_GROUP_UPDATED', 'Budget group updated')
  update(@Param('id') id: string, @Body() body: UpdateBudgetGroupDto) {
    return this.budgetGroupDBRepository.update(id, body)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a budget group (409 CATALOG_ITEM_IN_USE while categories belong to it)' })
  delete(@Param('id') id: string) {
    return this.budgetGroupDBRepository.delete(id)
  }
}
