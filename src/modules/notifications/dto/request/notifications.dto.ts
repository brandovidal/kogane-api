import { createZodDto } from 'nestjs-zod'

import {
  collectNowSchema,
  notificationListQuerySchema,
  recentQuerySchema,
  remindDebtsSchema,
  remindersQuerySchema,
  updateSettingsSchema,
} from '../../validations/notifications.validation'

export class NotificationListQueryDto extends createZodDto(notificationListQuerySchema) {}
export class RecentNotificationsQueryDto extends createZodDto(recentQuerySchema) {}
export class RemindersQueryDto extends createZodDto(remindersQuerySchema) {}
export class CollectNowDto extends createZodDto(collectNowSchema) {}
export class RemindDebtsDto extends createZodDto(remindDebtsSchema) {}
export class UpdateNotificationSettingsDto extends createZodDto(updateSettingsSchema) {}
