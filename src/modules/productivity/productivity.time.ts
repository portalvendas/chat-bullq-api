/**
 * Helpers de dia local para o painel de produtividade.
 *
 * Todo o banco guarda timestamps em UTC (timestamp sem fuso). O "dia" do
 * vendedor é o dia-calendário em America/Sao_Paulo. Estas funções convertem
 * entre os dois sem depender do fuso do servidor.
 */

import { Prisma } from '@prisma/client';

export const PRODUCTIVITY_TZ = 'America/Sao_Paulo';

/**
 * Instante JS → literal SQL `timestamp` em UTC, independente do TimeZone da
 * sessão do Postgres (as colunas são `timestamp` sem fuso, gravadas em UTC).
 */
export function sqlUtc(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Dia local YYYY-MM-DD de um instante. `localDay(new Date('2026-10-19T02:00Z'))` → '2026-10-18'. */
export function localDay(at: Date = new Date(), tz = PRODUCTIVITY_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
}

export function isValidDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const d = new Date(`${day}T12:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** Diferença (min) entre o relógio local do fuso e o UTC num instante. SP hoje = -180. */
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Início e fim (exclusivo) de um dia local, em UTC.
 * `dayBoundsUtc('2026-10-19')` → { start: 2026-10-19T03:00Z, end: 2026-10-20T03:00Z }.
 */
export function dayBoundsUtc(day: string, tz = PRODUCTIVITY_TZ): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number);
  const startGuess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const start = new Date(startGuess.getTime() - tzOffsetMinutes(startGuess, tz) * 60000);
  const endGuess = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  const end = new Date(endGuess.getTime() - tzOffsetMinutes(endGuess, tz) * 60000);
  return { start, end };
}

/** Trunca no minuto (UTC). */
export function truncMinute(at: Date = new Date()): Date {
  return new Date(Math.floor(at.getTime() / 60000) * 60000);
}

/** 1º token normalizado de um nome (sem acento/caixa). 'Gabriella Souza' → 'gabriella'. */
export function firstNameToken(name?: string | null): string | null {
  const t = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length >= 2);
  return t[0] ?? null;
}
