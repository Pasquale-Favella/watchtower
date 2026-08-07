import { z } from 'zod'

export const activeCurrencySchema = z.object({
  code: z.string(),
  symbol: z.string(),
  rate: z.number(),
  updatedAt: z.string().optional(),
})
export type ActiveCurrency = z.infer<typeof activeCurrencySchema>

export const currencyOptionSchema = z.object({
  code: z.string(),
  symbol: z.string(),
})
export type CurrencyOption = z.infer<typeof currencyOptionSchema>
