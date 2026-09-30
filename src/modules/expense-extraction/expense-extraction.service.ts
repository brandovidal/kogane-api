import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { z } from 'zod'

import {
  AI_MAX_STRUCTURE_ATTEMPTS,
  AI_QUOTA_TIME_ZONES,
  AI_QUOTA_USAGE_THRESHOLD,
  AiErrorCode,
  AiInputPartType,
  AiOperation,
  AiProvider,
} from '@/commons/constants/ai.constant'
import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { ExpenseField } from '@/commons/constants/expense-extraction.constant'
import { DateHelper } from '@/commons/helpers/date.helper'
import { ExpenseExtractionFailedException } from '@/commons/exceptions/expense-extraction/expense-extraction-failed.exception'
import { TranscriptionFailedException } from '@/commons/exceptions/expense-extraction/transcription-failed.exception'
import { GroqTranscriberService } from '@/providers/ai/groq/groq-transcriber.service'
import { AiConfig, GeminiConfig, GroqConfig } from '@/settings/settings.model'
import { AiExtractorProviderStrategy } from '@/providers/ai/ai-extractor-provider.strategy'
import { AiInputPart, GenerateJsonResponse } from '@/providers/ai/dto/ai-extractor.dto'
import { AiRequestLogDBRepository } from '@/db/models/ai-request-log/aiRequestLogDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { CategoryDBRepository } from '@/db/models/category/categoryDB.repository'

import { buildExtractionCatalog } from './expense-extraction.catalog'
import { resolveExpense } from './expense-extraction.resolver'
import { parseCorrection } from './correction-parser'
import { generateExpenseExtractionPrompt } from './prompts/expense-extraction.prompt'
import { expenseExtractionJsonSchema, expenseExtractionSchema } from './validations/expense-extraction.validation'
import {
  ExpenseExtractionInput,
  ExpenseExtractionResult,
  ExtractionCatalog,
  ResolvedExpenseFields,
  AiModelUsage,
  MediaFile,
} from './dto/expense-extraction.types'

interface ModelCandidate {
  provider: AiProvider
  model: string
  dailyLimit: number
}

type ExtractionOutput = z.infer<typeof expenseExtractionSchema>

type ParsedOutput = { success: true; data: ExtractionOutput } | { success: false; error: string }

@Injectable()
export class ExpenseExtractionService {
  private readonly logger = new Logger(ExpenseExtractionService.name)

  constructor(
    private readonly configService: ConfigService,
    private readonly aiExtractorProviderStrategy: AiExtractorProviderStrategy,
    private readonly aiRequestLogDBRepository: AiRequestLogDBRepository,
    private readonly personDBRepository: PersonDBRepository,
    private readonly paymentMethodDBRepository: PaymentMethodDBRepository,
    private readonly categoryDBRepository: CategoryDBRepository,
    private readonly groqTranscriberService: GroqTranscriberService,
  ) {}

  async loadCatalog(): Promise<ExtractionCatalog> {
    const [people, paymentMethods, categories] = await Promise.all([
      this.personDBRepository.findActive(),
      this.paymentMethodDBRepository.findActive(),
      this.categoryDBRepository.findAll(),
    ])

    return buildExtractionCatalog({ people, paymentMethods, categories })
  }

  // Corrections the bot understands without calling the AI; null means "ask the AI"
  async parseLocalCorrection(
    text: string,
    pendingField: ExpenseField | null,
  ): Promise<Partial<ResolvedExpenseFields> | null> {
    const catalog = await this.loadCatalog()
    return parseCorrection(text, pendingField, catalog, DateHelper.todayIn(APP_TIME_ZONE))
  }

  async extract(input: ExpenseExtractionInput): Promise<ExpenseExtractionResult> {
    const catalog = await this.loadCatalog()
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    const instructions = generateExpenseExtractionPrompt({ today, catalogText: catalog.promptText, draft: input.draft })
    const parts = this.buildParts(input)
    const hasImages = parts.some((part) => part.type === AiInputPartType.IMAGE)

    for (const candidate of this.buildRoute(hasImages)) {
      if (await this.isOverQuota(candidate)) {
        this.logger.warn(`[extract] ${candidate.provider}/${candidate.model} skipped: daily quota almost spent`)
        continue
      }

      const output = await this.tryCandidate(candidate, instructions, parts, input.draftId)

      if (output) {
        return {
          expenses: output.expenses.map((expense) => resolveExpense(expense, catalog, today)),
          unreadable: output.unreadable ?? [],
          received: output.received ?? [],
          provider: candidate.provider,
          model: candidate.model,
        }
      }
    }

    throw new ExpenseExtractionFailedException({ draftId: input.draftId })
  }

  // Any other structured reading of a text (bank statements, P14): same route, quota and logs as extract(). null when no
  // model answered valid JSON
  async generateStructured<T>({
    instructions,
    text,
    jsonSchema,
    parse,
    operation,
  }: {
    instructions: string
    text: string
    jsonSchema: Record<string, unknown>
    parse: (json: unknown) => { success: true; data: T } | { success: false; error: string }
    operation: AiOperation
  }): Promise<T | null> {
    const { timeoutMs } = this.configService.getOrThrow<AiConfig>('ai')
    const parts: AiInputPart[] = [{ type: AiInputPartType.TEXT, text }]

    // A statement lists dozens of movements, far over the ~900 output tokens Groq allows per answer (it would cut the
    // list short and drop movements silently): Gemini answers first, Groq is the last resort
    const route = this.buildRoute(false)
    const candidates =
      operation === AiOperation.STATEMENT
        ? [
            ...route.filter((c) => c.provider === AiProvider.GEMINI),
            ...route.filter((c) => c.provider !== AiProvider.GEMINI),
          ]
        : route
    for (const candidate of candidates) {
      if (await this.isOverQuota(candidate)) continue
      const provider = this.aiExtractorProviderStrategy.getProvider(candidate.provider)
      const startedAt = Date.now()
      try {
        const response = await provider.generateJson({
          model: candidate.model,
          instructions,
          parts,
          jsonSchema,
          timeoutMs,
        })
        let parsed: ReturnType<typeof parse>
        try {
          parsed = parse(JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, '')))
        } catch {
          parsed = { success: false, error: 'Response is not valid JSON' }
        }
        await this.logRequest(
          candidate,
          undefined,
          Date.now() - startedAt,
          parsed.success ? undefined : AiErrorCode.INVALID_OUTPUT,
          response,
          operation,
        )
        if (parsed.success) return parsed.data
      } catch (error) {
        this.logger.warn(
          `[generateStructured] ${candidate.provider}/${candidate.model} failed: ${(error as Error).message}`,
        )
        await this.logRequest(
          candidate,
          undefined,
          Date.now() - startedAt,
          AiErrorCode.PROVIDER_ERROR,
          undefined,
          operation,
        )
      }
    }
    return null
  }

  // Voice note -> text with Whisper on Groq (P5); the text then goes through extract() like a typed message
  async transcribe({ audio, draftId }: { audio: MediaFile; draftId?: string }): Promise<string> {
    const candidate = this.transcribeCandidate()

    if (await this.isOverQuota(candidate)) {
      throw new TranscriptionFailedException({ draftId, reason: 'daily quota almost spent' })
    }

    const { timeoutMs } = this.configService.getOrThrow<AiConfig>('ai')
    const startedAt = Date.now()

    try {
      const text = await this.groqTranscriberService.transcribe({
        model: candidate.model,
        mimeType: audio.mimeType,
        data: audio.data,
        timeoutMs,
      })
      await this.logRequest(candidate, draftId, Date.now() - startedAt, undefined, undefined, AiOperation.TRANSCRIBE)
      return text
    } catch (error) {
      this.logger.warn(`[transcribe] ${candidate.provider}/${candidate.model} failed: ${(error as Error).message}`)
      await this.logRequest(
        candidate,
        draftId,
        Date.now() - startedAt,
        AiErrorCode.PROVIDER_ERROR,
        undefined,
        AiOperation.TRANSCRIBE,
      )
      throw new TranscriptionFailedException({ draftId })
    }
  }

  // Every model of both routes, once, with today's calls (each provider resets at its own midnight)
  async getUsage(): Promise<AiModelUsage[]> {
    const candidates = [...this.buildRoute(false), ...this.buildRoute(true), this.transcribeCandidate()].filter(
      (candidate, index, all) => all.findIndex((other) => other.model === candidate.model) === index,
    )

    return Promise.all(
      candidates.map(async ({ provider, model, dailyLimit }) => ({
        provider,
        model,
        used: await this.countToday(provider, model),
        dailyLimit,
        usableLimit: Math.floor(dailyLimit * AI_QUOTA_USAGE_THRESHOLD),
      })),
    )
  }

  private transcribeCandidate(): ModelCandidate {
    const groq = this.configService.getOrThrow<GroqConfig>('groq')
    return { provider: AiProvider.GROQ, model: groq.transcribeModel, dailyLimit: groq.transcribeDailyLimit }
  }

  // Text: Flash-Lite and Qwen (on Groq), in the order of AI_TEXT_PRIMARY. Images: Flash-Lite, then Flash
  // (Groq is text-only).
  private buildRoute(hasImages: boolean): ModelCandidate[] {
    const gemini = this.configService.getOrThrow<GeminiConfig>('gemini')
    const groq = this.configService.getOrThrow<GroqConfig>('groq')
    const { textPrimary } = this.configService.getOrThrow<AiConfig>('ai')

    const geminiLite = { provider: AiProvider.GEMINI, model: gemini.modelLite, dailyLimit: gemini.dailyLimitLite }
    const qwen = { provider: AiProvider.GROQ, model: groq.model, dailyLimit: groq.dailyLimit }

    if (hasImages)
      return [geminiLite, { provider: AiProvider.GEMINI, model: gemini.model, dailyLimit: gemini.dailyLimit }]
    return textPrimary === AiProvider.GROQ ? [qwen, geminiLite] : [geminiLite, qwen]
  }

  private async isOverQuota({ provider, model, dailyLimit }: ModelCandidate): Promise<boolean> {
    const used = await this.countToday(provider, model)
    return used >= Math.floor(dailyLimit * AI_QUOTA_USAGE_THRESHOLD)
  }

  private countToday(provider: AiProvider, model: string): Promise<number> {
    return this.aiRequestLogDBRepository.countSince(
      provider,
      model,
      DateHelper.startOfDayIn(AI_QUOTA_TIME_ZONES[provider]),
    )
  }

  private async tryCandidate(
    candidate: ModelCandidate,
    instructions: string,
    parts: AiInputPart[],
    draftId?: string,
  ): Promise<ExtractionOutput | null> {
    const provider = this.aiExtractorProviderStrategy.getProvider(candidate.provider)
    const { timeoutMs } = this.configService.getOrThrow<AiConfig>('ai')
    let attemptParts = parts

    for (let attempt = 1; attempt <= AI_MAX_STRUCTURE_ATTEMPTS; attempt++) {
      const startedAt = Date.now()
      let response: GenerateJsonResponse

      try {
        response = await provider.generateJson({
          model: candidate.model,
          instructions,
          parts: attemptParts,
          jsonSchema: expenseExtractionJsonSchema,
          timeoutMs,
        })
      } catch (error) {
        this.logger.warn(`[tryCandidate] ${candidate.provider}/${candidate.model} failed: ${(error as Error).message}`)
        await this.logRequest(candidate, draftId, Date.now() - startedAt, AiErrorCode.PROVIDER_ERROR)
        return null
      }

      const parsed = this.parseOutput(response.text)
      await this.logRequest(
        candidate,
        draftId,
        Date.now() - startedAt,
        parsed.success ? undefined : AiErrorCode.INVALID_OUTPUT,
        response,
      )

      if (parsed.success) return parsed.data

      // Same idea as mms-ai buildRetryMessage: show the model its output and the validation error
      attemptParts = [
        ...parts,
        {
          type: AiInputPartType.TEXT,
          text: `Your previous response did not match the schema.\nResponse:\n${response.text}\nErrors:\n${parsed.error}\nRespond again with only valid JSON.`,
        },
      ]
    }

    return null
  }

  private parseOutput(text: string): ParsedOutput {
    let json: unknown

    try {
      json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    } catch (_error) {
      return { success: false, error: 'Response is not valid JSON' }
    }

    const result = expenseExtractionSchema.safeParse(json)
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: z.prettifyError(result.error) }
  }

  private buildParts({ text, images, draft }: ExpenseExtractionInput): AiInputPart[] {
    const parts: AiInputPart[] = (images ?? []).map((image) => ({
      type: AiInputPartType.IMAGE,
      mimeType: image.mimeType,
      data: image.data,
    }))

    const message = text?.trim() || (draft ? '' : 'Extract the expenses from the image(s).')
    if (message) parts.push({ type: AiInputPartType.TEXT, text: message })

    return parts
  }

  private async logRequest(
    { provider, model }: ModelCandidate,
    draftId: string | undefined,
    latencyMs: number,
    errorCode?: AiErrorCode,
    response?: GenerateJsonResponse,
    operation = AiOperation.EXTRACT,
  ) {
    try {
      await this.aiRequestLogDBRepository.create({
        provider,
        model,
        operation,
        draftId: draftId ?? null,
        success: !errorCode,
        errorCode: errorCode ?? null,
        inputTokens: response?.inputTokens ?? null,
        outputTokens: response?.outputTokens ?? null,
        latencyMs,
      })
    } catch (error) {
      // Losing a usage row must not lose the user's expense
      this.logger.error(`[logRequest] could not save AI request log: ${(error as Error).message}`)
    }
  }
}
