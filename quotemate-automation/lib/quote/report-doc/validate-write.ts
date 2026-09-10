import { z } from 'zod'
import type { ReportDoc } from './types'

// Match the existing serializer's limits, but reject invalid writes instead of
// silently discarding blocks or clipping an owner's unsaved narrative.
const inline = z.object({
  text: z.string().min(1).max(5000),
  marks: z.array(z.enum(['bold', 'italic', 'underline', 'highlight'])).optional(),
}).strict()
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('title'), content: z.array(inline) }).strict(),
  z.object({ type: z.literal('heading'), content: z.array(inline) }).strict(),
  z.object({ type: z.literal('paragraph'), content: z.array(inline) }).strict(),
  z.object({ type: z.literal('bulletList'), items: z.array(z.array(inline)) }).strict(),
  z.object({ type: z.literal('pricing') }).strict(),
])
const document = z.object({ version: z.literal(1), blocks: z.array(block).max(300) }).strict()
  .refine(value => value.blocks.filter(item => item.type === 'pricing').length === 1)

export function validateReportDocWrite(value: unknown): ReportDoc | null {
  const parsed = document.safeParse(value)
  return parsed.success ? parsed.data : null
}
