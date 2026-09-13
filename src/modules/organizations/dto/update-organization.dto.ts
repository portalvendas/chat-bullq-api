import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'My Company' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  // ─── AI settings ────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Master kill switch for AI agents' })
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Modo revisão global: toda resposta da IA fica pendente de aprovação humana no inbox antes de ir pro cliente.',
  })
  @IsOptional()
  @IsBoolean()
  aiReviewMode?: boolean;

  @ApiPropertyOptional({
    description:
      'Assinatura fixa anexada ao final de toda resposta da IA. Vazio = sem assinatura.',
  })
  @IsOptional()
  @IsString()
  aiSignature?: string;

  @ApiPropertyOptional({ example: 'America/Sao_Paulo' })
  @IsOptional()
  @IsString()
  aiTimezone?: string;

  @ApiPropertyOptional({
    description:
      'Business hours by weekday. Object with monday..sunday keys, each {enabled, windows: [["09:00","18:00"]]}. Pass null to mean 24/7 (IA responde a qualquer hora).',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  aiBusinessHours?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Message sent automatically when an inbound arrives outside business hours. Empty = no auto-reply.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  aiOutOfHoursMessage?: string;

  @ApiPropertyOptional({
    description:
      'When true, AI is auto-paused on a conversation as soon as a human sends a reply.',
  })
  @IsOptional()
  @IsBoolean()
  aiAutoDisableOnHuman?: boolean;

  @ApiPropertyOptional({
    description: 'Monthly LLM token cap across the org. null = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  aiMonthlyTokenCap?: number;

  @ApiPropertyOptional({
    description:
      'Notas livres que entram no system prompt de TODOS os agentes da org. Use pra info que muda com frequência (regras de entrega de isca, horários de live, política de reembolso, talking points atuais). Empty = sem notas.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(4000)
  aiBusinessNotes?: string | null;

  @ApiPropertyOptional({
    description:
      'Lista de domínios permitidos em URLs que a IA pode mandar (ex: ["bravy.co", "trivapp.com.br"]). Quando preenchida, runtime guard bloqueia qualquer link com host fora da lista — IA é forçada a reescrever sem link inventado. Vazia/null = permissivo (só warning). Match é por sufixo: "bravy.co" autoriza "members.bravy.co".',
    nullable: true,
    type: [String],
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsArray()
  @IsString({ each: true })
  allowedUrlDomains?: string[] | null;

  // ─── Expediente (horário de funcionamento) ──────────────────────
  // FONTE ÚNICA de horário: rege IA, watchdog, salesbots e métricas.

  @ApiPropertyOptional({
    description: 'true = aberto 24/7 (sempre dentro do horário). false = usa a agenda.',
  })
  @IsOptional()
  @IsBoolean()
  businessHours247?: boolean;

  @ApiPropertyOptional({ example: 'America/Sao_Paulo' })
  @IsOptional()
  @IsString()
  businessTimezone?: string;

  @ApiPropertyOptional({
    description:
      'Agenda por dia: { monday: { enabled, windows: [["08:00","12:00"],["13:30","17:30"]] }, ... }. Múltiplas janelas/dia (almoço).',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  businessHoursSchedule?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Feriados (dias fechados): [{ date: "YYYY-MM-DD" | "MM-DD", label?, annual? }].',
    nullable: true,
    type: [Object],
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsArray()
  businessHolidays?: unknown[] | null;

  @ApiPropertyOptional({
    description:
      'Mensagem padrão de fora de expediente (opcional). Vazio = sem mensagem.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  businessOutOfHoursMessage?: string | null;

  // ─── Watchdog settings ──────────────────────────────────────────

  @ApiPropertyOptional({
    description:
      'Liga/desliga o watchdog de conversas presas. Quando ON, varre conversas onde IA travou ou humano abandonou e reativa atendimento.',
  })
  @IsOptional()
  @IsBoolean()
  watchdogEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Horário em que o watchdog atua. Mesmo formato de `aiBusinessHours`. null = roda 24/7.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  watchdogBusinessHours?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Parâmetros do watchdog: `{ delayBotMin, delayPendingMin, delayHumanIdleMin, maxAttempts }`. null = usa defaults (15, 15, 60, 3).',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  watchdogConfig?: WatchdogConfigDto | null;
}

export interface WatchdogConfigDto {
  /// Minutos sem resposta com status=BOT antes de reativar IA.
  delayBotMin?: number;
  /// Minutos sem resposta com status=PENDING antes de IA assumir.
  delayPendingMin?: number;
  /// Minutos sem resposta com status=OPEN (humano atribuído) antes de IA reassumir.
  delayHumanIdleMin?: number;
  /// Tentativas antes de marcar como `isStuck` e parar de tentar IA.
  maxAttempts?: number;
}
