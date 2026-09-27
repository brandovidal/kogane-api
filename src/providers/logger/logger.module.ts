import { Global, Module } from '@nestjs/common'
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino'
import type { IncomingMessage } from 'http'
import type { Level, LevelWithSilent, TransportSingleOptions } from 'pino'

import { LOG_CONTEXT_KEY, LOGGER_NAMESPACE, LOGGER_TRANSPORT_OPTION_IGNORE } from '@/commons/constants/logger.constant'

interface ExpressLikeRequest extends IncomingMessage {
  route?: { path: string }
  baseUrl?: string
  originalUrl?: string
  params?: unknown
  query?: unknown
  [LOG_CONTEXT_KEY]?: Record<string, unknown>
}

const getRoutePath = (req: IncomingMessage): string | undefined => {
  const expressReq = req as ExpressLikeRequest
  return expressReq.route ? `${expressReq.baseUrl ?? ''}${expressReq.route.path}` : expressReq.originalUrl
}

const isDev = (process.env.NODE_ENV ?? 'dev') === 'dev'

const configuredLogLevel = process.env.LOG_LEVEL?.trim()
const logLevel = (configuredLogLevel || (isDev ? 'debug' : 'info')) as Level

const customLogLevel = (_req: IncomingMessage, res: { statusCode: number }, err?: Error): LevelWithSilent => {
  if (err || res.statusCode >= 500) return 'error'
  if (res.statusCode >= 400) return 'warn'
  return 'info'
}

// Pretty logs locally, plain JSON on stdout elsewhere
const transport: TransportSingleOptions | undefined = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        ignore: LOGGER_TRANSPORT_OPTION_IGNORE,
      },
    }
  : undefined

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        name: LOGGER_NAMESPACE,
        level: logLevel,
        customLogLevel,
        transport,
        serializers: {
          req: (req: ExpressLikeRequest) => ({
            method: req.method,
            url: req.url,
            params: req.params,
            query: req.query,
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          err: (err: Error) => ({ type: err.name, message: err.message }),
        },
        customProps: (req) => ({
          routePath: getRoutePath(req),
          ...((req as ExpressLikeRequest)[LOG_CONTEXT_KEY] ?? {}),
        }),
      },
    }),
  ],
  controllers: [],
  providers: [],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
