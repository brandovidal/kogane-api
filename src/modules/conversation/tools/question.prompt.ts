import { z } from 'zod'

// /pregunta (P18, D131): the AI does not see any expense. It only reads the question and picks ONE of these queries;
// the numbers come from the database
export const QUESTION_INSTRUCTIONS = `You turn a question about personal spending (Spanish, Peru) into ONE query. Return JSON with:
- kind: "total" (how much was spent), "top" (what the most went to, grouped by groupBy), "biggest" (the largest
  individual expenses), "compare" (this period against the previous month) or "unknown" when the question is not about
  the user's own expenses.
- month: 1-12 of the period asked, or null for the current month. year: 4 digits or null for the current year.
  "el mes pasado" is the month before the current one.
- groupBy: "category", "method" (payment method) or "day", only for "top"; otherwise null.
- category: the category the user names (e.g. "comida"), or null. paymentMethod: the card or wallet named (e.g. "yape",
  "cmr"), or null.
- text: a word or two of the concept of the expense (e.g. "uber", "netflix"), or null.
Never answer the question and never invent numbers: only choose the query.`

export const questionSchema = z.object({
  kind: z.enum(['total', 'top', 'biggest', 'compare', 'unknown']),
  month: z.number().int().min(1).max(12).nullable(),
  year: z.number().int().min(2000).max(2100).nullable(),
  groupBy: z.enum(['category', 'method', 'day']).nullable(),
  category: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  text: z.string().nullable(),
})

export type QuestionQuery = z.infer<typeof questionSchema>

// Without $schema (Gemini rejects it), as the other prompts
export const questionJsonSchema = (() => {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(questionSchema) as Record<string, unknown>
  return jsonSchema
})()
