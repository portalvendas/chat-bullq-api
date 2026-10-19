import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const ACTIVITY_STATES = ['background', 'idle', 'active'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Peso gravado no banco (maior vence quando várias abas batem no mesmo minuto). */
export const STATE_RANK: Record<ActivityState, number> = {
  background: 1,
  idle: 2,
  active: 3,
};

/**
 * Heartbeat do navegador (a cada ~30s enquanto o CRM está aberto).
 *
 * Exemplo:
 *   POST /productivity/heartbeat
 *   { "state": "active", "area": "inbox", "conversationId": "cmg8x…" }
 *   → 204
 */
export class HeartbeatDto {
  @IsIn(ACTIVITY_STATES as unknown as string[])
  state!: ActivityState;

  /** 1º segmento da rota (inbox, pipelines, dashboard…). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9-]*$/)
  area?: string;

  /** Conversa aberta na tela, se houver. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9_-]+$/)
  conversationId?: string;
}
