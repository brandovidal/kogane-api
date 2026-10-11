import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { StorageEnv } from '@/commons/constants/stored-file.constant'
import { StorageConfig } from '@/settings/settings.model'

import { LocalStorage } from './local.storage'
import { R2Storage } from './r2.storage'
import { ObjectStorage } from './storage.types'

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE')

@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ObjectStorage => {
        const config = configService.getOrThrow<StorageConfig>('storage')
        const { env, r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket, localDir } = config

        if (!Object.values<string | undefined>(StorageEnv).includes(env)) {
          throw new Error('STORAGE_ENV must be dev, qa, prod or test (the parent folder of the files in R2)')
        }
        // Tests never call R2 (like the AI): files go to a git-ignored folder
        if (env === StorageEnv.TEST) return new LocalStorage(localDir)

        if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey) {
          throw new Error(`R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required (STORAGE_ENV=${env})`)
        }
        return new R2Storage(r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket)
      },
    },
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageProviderModule {}
