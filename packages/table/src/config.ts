import { readFileSync } from "node:fs";
import { z } from "zod";

const ModelSeatSchema = z.object({
  type: z.literal("model"),
  name: z.string().min(1),
  model: z.string().min(1),
  buyInTokens: z.number().int().positive().optional(),
  /** Completion budget per decision; reasoning tokens count against it. */
  maxTokens: z.number().int().positive().optional(),
});

const AcpSeatSchema = z
  .object({
    type: z.literal("acp"),
    name: z.string().min(1),
    /** Built-in launchers. Use `cmd` for anything else that speaks ACP. */
    agent: z.enum(["claude", "codex"]).optional(),
    cmd: z.array(z.string().min(1)).min(1).optional(),
    buyInTokens: z.number().int().positive().optional(),
  })
  .refine((seat) => seat.agent !== undefined || seat.cmd !== undefined, {
    message: 'acp seat needs "agent" ("claude" | "codex") or a "cmd" array',
  });

const HumanSeatSchema = z.object({
  type: z.literal("human"),
  name: z.string().min(1),
  buyInTokens: z.number().int().positive().optional(),
});

const McpSeatSchema = z.object({
  type: z.literal("mcp"),
  name: z.string().min(1),
  buyInTokens: z.number().int().positive().optional(),
});

const SeatSchema = z.discriminatedUnion("type", [
  ModelSeatSchema,
  AcpSeatSchema,
  HumanSeatSchema,
  McpSeatSchema,
]);

export const TableStakesConfigSchema = z
  .object({
    table: z.string().min(1),
    game: z.literal("NLHE").default("NLHE"),
    chips: z.object({
      referenceModel: z.string().min(1),
      tokensPerChip: z.number().int().positive(),
    }),
    blinds: z.object({
      small: z.number().int().positive(),
      big: z.number().int().positive(),
    }),
    buyIn: z.object({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    }),
    clock: z
      .object({
        modelSeconds: z.number().positive().default(45),
        acpSeconds: z.number().positive().default(120),
        humanSeconds: z.number().positive().default(45),
        mcpSeconds: z.number().positive().default(60),
        timeoutAction: z.literal("fold").default("fold"),
      })
      .prefault({}),
    chat: z
      .object({
        enabled: z.boolean().default(true),
        maxPerRound: z.number().int().positive().default(3),
        maxChars: z.number().int().positive().default(200),
        reactions: z.boolean().default(true),
        banterPrompts: z.enum(["off", "showdown"]).default("showdown"),
      })
      .prefault({}),
    rules: z
      .object({
        thinkingBurnsStack: z.boolean().default(false),
      })
      .prefault({}),
    web: z
      .object({
        enabled: z.boolean().default(true),
        port: z.number().int().min(1024).max(65535).default(7787),
      })
      .prefault({}),
    hands: z.number().int().positive().default(6),
    seats: z.array(SeatSchema).min(2).max(10),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.blinds.small >= cfg.blinds.big) {
      ctx.addIssue({ code: "custom", path: ["blinds"], message: "small blind must be below the big blind" });
    }
    if (cfg.buyIn.min > cfg.buyIn.max) {
      ctx.addIssue({ code: "custom", path: ["buyIn"], message: "buyIn.min must not exceed buyIn.max" });
    }
    const names = new Set<string>();
    cfg.seats.forEach((seat, i) => {
      if (names.has(seat.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["seats", i, "name"],
          message: `duplicate seat name "${seat.name}" — names identify players in views, chat, and the ledger`,
        });
      }
      names.add(seat.name);
      if (seat.buyInTokens !== undefined && (seat.buyInTokens < cfg.buyIn.min || seat.buyInTokens > cfg.buyIn.max)) {
        ctx.addIssue({
          code: "custom",
          path: ["seats", i, "buyInTokens"],
          message: `buy-in must be within [${cfg.buyIn.min}, ${cfg.buyIn.max}]`,
        });
      }
    });
  });

export type TableStakesConfig = z.infer<typeof TableStakesConfigSchema>;
export type SeatConfig = z.infer<typeof SeatSchema>;

export function loadConfig(path: string): TableStakesConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return TableStakesConfigSchema.parse(raw);
}
