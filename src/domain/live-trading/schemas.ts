// =================================================================
// Live Trading Zod Schemas — STAGE 3-A
//
// Validation Rules:
//   - BUY/SELL: volume必須 (> 0), symbol必須
//   - CLOSE:    positionTicket必須
//   - MODIFY_*: positionTicket必須, 対象値必須
//   - NaN price → reject
//   - 期限切れ expiresAt → reject
//   - magic_number 範囲チェック（20001〜29999）
// =================================================================

import { z } from "zod";

// -----------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------

const isoDatetime = z
  .string()
  .datetime({ message: "ISO 8601 datetime が必要です" });

const positiveNumber = z
  .number()
  .positive()
  .finite()
  .refine((v) => !Number.isNaN(v), { message: "NaN は不可です" });

const nonNegativeNumber = z
  .number()
  .nonnegative()
  .finite()
  .refine((v) => !Number.isNaN(v), { message: "NaN は不可です" });

// Magic Number は 20001〜29999 の範囲
const magicNumberSchema = z
  .number()
  .int()
  .min(20001, "magic_number は 20001 以上")
  .max(29999, "magic_number は 29999 以下");

// -----------------------------------------------------------------
// Action
// -----------------------------------------------------------------

export const ExecutionActionSchema = z.enum([
  "BUY",
  "SELL",
  "CLOSE",
  "MODIFY_SL",
  "MODIFY_TP",
]);

// -----------------------------------------------------------------
// Create Execution Command Input Schema
// -----------------------------------------------------------------

export const CreateExecutionCommandSchema = z
  .object({
    commandId:      z.string().uuid("commandId は UUID v4 が必要です"),
    connectionId:   z.string().uuid("connectionId は UUID が必要です"),
    strategyId:     z.string().uuid("strategyId は UUID が必要です"),
    magicNumber:    magicNumberSchema,
    signalId:       z.string().uuid().optional(),

    action:         ExecutionActionSchema,
    symbol:         z
      .string()
      .min(1)
      .max(20)
      .regex(/^[A-Z0-9.]+$/, "symbolは英大文字・数字・ドットのみ"),
    volume:         positiveNumber.optional(),

    requestedPrice: nonNegativeNumber.optional(),
    stopLoss:       nonNegativeNumber.optional(),
    takeProfit:     nonNegativeNumber.optional(),

    positionTicket: z.number().int().positive().optional(),
    orderTicket:    z.number().int().positive().optional(),

    expiresAt:      isoDatetime,

    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    // BUY/SELL: volume必須
    if ((data.action === "BUY" || data.action === "SELL") && !data.volume) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["volume"],
        message: "BUY/SELL には volume が必要です",
      });
    }

    // CLOSE: positionTicket必須
    if (data.action === "CLOSE" && !data.positionTicket) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["positionTicket"],
        message: "CLOSE には positionTicket が必要です",
      });
    }

    // MODIFY_SL: positionTicket + stopLoss必須
    if (data.action === "MODIFY_SL") {
      if (!data.positionTicket) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["positionTicket"],
          message: "MODIFY_SL には positionTicket が必要です",
        });
      }
      if (data.stopLoss === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stopLoss"],
          message: "MODIFY_SL には stopLoss が必要です",
        });
      }
    }

    // MODIFY_TP: positionTicket + takeProfit必須
    if (data.action === "MODIFY_TP") {
      if (!data.positionTicket) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["positionTicket"],
          message: "MODIFY_TP には positionTicket が必要です",
        });
      }
      if (data.takeProfit === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["takeProfit"],
          message: "MODIFY_TP には takeProfit が必要です",
        });
      }
    }

    // expiresAt が過去ならreject
    if (new Date(data.expiresAt) <= new Date()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt は未来の時刻が必要です（Command作成時）",
      });
    }
  });

export type CreateExecutionCommandInput = z.infer<typeof CreateExecutionCommandSchema>;

// -----------------------------------------------------------------
// Execution Result Schema (Gateway から受け取る)
// -----------------------------------------------------------------

export const ExecutionResultSchema = z.object({
  commandId:          z.string().min(1),
  success:            z.boolean(),
  retcode:            z.number().int().nullable(),
  retcodeDescription: z.string().nullable().optional(),
  orderTicket:        z.number().int().positive().nullable().optional(),
  dealTicket:         z.number().int().positive().nullable().optional(),
  positionTicket:     z.number().int().positive().nullable().optional(),
  requestedPrice:     nonNegativeNumber.nullable().optional(),
  executionPrice:     nonNegativeNumber.nullable().optional(),
  requestedVolume:    positiveNumber.nullable().optional(),
  executedVolume:     positiveNumber.nullable().optional(),
  stopLoss:           nonNegativeNumber.nullable().optional(),
  takeProfit:         nonNegativeNumber.nullable().optional(),
  brokerTime:         isoDatetime.nullable().optional(),
  errorCode:          z.number().int().nullable().optional(),
  errorMessage:       z.string().nullable().optional(),
  receivedAt:         isoDatetime,
});

export type ExecutionResultInput = z.infer<typeof ExecutionResultSchema>;

// -----------------------------------------------------------------
// MT5 Connection Schema
// -----------------------------------------------------------------

export const CreateMT5ConnectionSchema = z.object({
  broker:          z.string().min(1).max(100),
  serverName:      z.string().min(1).max(200),
  mt5Login:        z.number().int().positive(),
  accountCurrency: z.string().length(3).regex(/^[A-Z]{3}$/).default("USD"),
  accountType:     z.enum(["REAL", "DEMO"]).default("DEMO"),
  accountMode:     z.enum(["HEDGING", "NETTING"]).default("HEDGING"),
  leverage:        z.number().int().positive().nullable().optional(),
});

export type CreateMT5ConnectionInput = z.infer<typeof CreateMT5ConnectionSchema>;

// -----------------------------------------------------------------
// Strategy Signal Schema
// -----------------------------------------------------------------

export const CreateStrategySignalSchema = z.object({
  strategyId:     z.string().uuid(),
  connectionId:   z.string().uuid().nullable().optional(),
  symbol:         z.string().min(1).max(20),
  timeframe:      z.string().min(1).max(10),
  direction:      z.enum(["BUY", "SELL", "EXIT_LONG", "EXIT_SHORT"]),
  signalTime:     isoDatetime,
  barTime:        isoDatetime,
  referencePrice: nonNegativeNumber.optional(),
  suggestedSl:    nonNegativeNumber.optional(),
  suggestedTp:    nonNegativeNumber.optional(),
  reason:         z.record(z.unknown()).optional(),
  metadata:       z.record(z.unknown()).optional(),
});

export type CreateStrategySignalInput = z.infer<typeof CreateStrategySignalSchema>;
