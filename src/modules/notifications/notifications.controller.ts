import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiParam } from '@nestjs/swagger'

import { NotificationJob } from '@/commons/constants/notification.constant'
import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { EmptyResponseDto } from '@/commons/helpers/api-response.helper'

import {
  CollectNowDto,
  NotificationListQueryDto,
  RecentNotificationsQueryDto,
  RemindDebtsDto,
  RemindersQueryDto,
  UpdateNotificationSettingsDto,
} from './dto/request/notifications.dto'
import {
  JobResultResponseDto,
  NotificationPageResponseDto,
  NotificationSettingsResponseDto,
  ReadAllResponseDto,
  RecentNotificationsResponseDto,
  RemindersResponseDto,
  UnreadCountResponseDto,
} from './dto/response/notifications-response.dto'
import { NotificationJobsService } from './notification-jobs.service'
import { NotificationsService } from './notifications.service'

// Notifications of the web (P20, D86): the bell, the history, the settings per channel and running a job by hand
@ApiRest('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationJobsService: NotificationJobsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'History of notifications, newest first' })
  @ApiOkResponse({ type: NotificationPageResponseDto })
  @ResponseMessage('NOTIFICATIONS_LISTED', 'Notifications listed')
  history(@Query() query: NotificationListQueryDto) {
    return this.notificationsService.history(query)
  }

  @Get('recent')
  @ApiOperation({ summary: 'Latest notifications for the bell (from Redis, rebuilt from the database)' })
  @ApiOkResponse({ type: RecentNotificationsResponseDto })
  @ResponseMessage('NOTIFICATIONS_RECENT', 'Recent notifications')
  recent(@Query() { limit }: RecentNotificationsQueryDto) {
    return this.notificationsService.recent(limit)
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notifications (the number on the bell)' })
  @ApiOkResponse({ type: UnreadCountResponseDto })
  @ResponseMessage('NOTIFICATIONS_UNREAD', 'Unread notifications')
  async unreadCount() {
    return { unread: await this.notificationsService.unreadCount() }
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every notification as read' })
  @ApiOkResponse({ type: ReadAllResponseDto })
  @ResponseMessage('NOTIFICATIONS_READ', 'Notifications read')
  async readAll() {
    return { updated: await this.notificationsService.markAllRead() }
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read (also when it was answered in Telegram)' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('NOTIFICATION_READ', 'Notification read')
  async read(@Param('id') id: string) {
    await this.notificationsService.markRead(id)
    return null
  }

  @Patch(':id/unread')
  @ApiOperation({ summary: 'Mark one notification as unread again (the bell counts it)' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('NOTIFICATION_UNREAD', 'Notification unread')
  async unread(@Param('id') id: string) {
    await this.notificationsService.markUnread(id)
    return null
  }

  @Get('settings')
  @ApiOperation({ summary: 'Which kinds of notification go to Telegram and to the web bell' })
  @ApiOkResponse({ type: NotificationSettingsResponseDto })
  @ResponseMessage('NOTIFICATION_SETTINGS', 'Notification settings')
  settings() {
    return this.notificationsService.settings()
  }

  @Put('settings')
  @ApiOperation({ summary: 'Change the channels of some kinds; the rest stay as they are' })
  @ApiOkResponse({ type: NotificationSettingsResponseDto })
  @ResponseMessage('NOTIFICATION_SETTINGS_UPDATED', 'Notification settings updated')
  updateSettings(@Body() body: UpdateNotificationSettingsDto) {
    return this.notificationsService.updateSettings(body)
  }

  @Post('run/:job')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'job', enum: NotificationJob })
  @ApiOperation({ summary: 'Run a scheduled job now (make notify JOB=…); notices already sent are not repeated' })
  @ApiOkResponse({ type: JobResultResponseDto })
  @ResponseMessage('NOTIFICATION_JOB_DONE', 'Job done')
  run(@Param('job', new ParseEnumPipe(NotificationJob)) job: NotificationJob) {
    return this.notificationJobsService.run(job)
  }

  @Post('collect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cobrar por Mensajes: send now the cobros notices of a month (one per person), once per person and day',
  })
  @ApiOkResponse({ type: JobResultResponseDto })
  @ResponseMessage('NOTIFICATION_COLLECT_SENT', 'Cobros sent')
  collect(@Body() body: CollectNowDto) {
    return this.notificationJobsService.collectNow(body)
  }

  @Post('remind-debts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recordar pago: one reminder per person for the selected debts; paid ones are left out' })
  @ApiOkResponse({ type: JobResultResponseDto })
  @ResponseMessage('NOTIFICATION_DEBTS_REMINDED', 'Reminders sent')
  remindDebts(@Body() { ids }: RemindDebtsDto) {
    return this.notificationJobsService.remindDebts(ids)
  }
}

// Upcoming reminders (P20, D87): what is due in the next days, read from Redis
@ApiRest('notifications')
@Controller('reminders')
export class RemindersController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'What closes or is due in the next days (at most 45), from the Redis list' })
  @ApiOkResponse({ type: RemindersResponseDto })
  @ResponseMessage('REMINDERS_LISTED', 'Reminders listed')
  list(@Query() { days }: RemindersQueryDto) {
    return this.notificationsService.upcoming(days)
  }
}
