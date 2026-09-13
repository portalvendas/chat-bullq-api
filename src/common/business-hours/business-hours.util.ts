/**
 * Motor de EXPEDIENTE (fonte única de horário de funcionamento).
 *
 * Puro e testável — nenhuma dependência de Nest/Prisma. Recebe só os campos
 * de expediente da Organization e responde às três perguntas que todo
 * consumidor faz:
 *   - `isOpenAt(org, at?)`        → estamos dentro do expediente agora/nessa hora?
 *   - `nextOpenFrom(org, fromMs)` → qual o próximo instante de abertura? (delay)
 *   - `businessMinutesBetween()`  → quantos minutos de expediente entre A e B? (métricas)
 *
 * Regras suportadas: modo 24/7, fuso IANA, múltiplas janelas por dia
 * (ex.: fecha no almoço) e feriados (data fixa YYYY-MM-DD ou anual MM-DD).
 *
 * Exemplo de `businessHoursSchedule`:
 * {
 *   "monday": { "enabled": true, "windows": [["08:00","12:00"],["13:30","17:30"]] },
 *   "saturday": { "enabled": false, "windows": [] }
 * }
 * Exemplo de `businessHolidays`: [{ "date": "2026-12-25", "label": "Natal", "annual": true }]
 */

export type Weekday =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

/** Índice getUTCDay/Intl (0 = domingo) → chave do dia. */
export const DAY_INDEX: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export interface BusinessHoursDay {
  enabled: boolean;
  windows?: Array<[string, string]>; // [["08:00","17:30"]]
}
export type BusinessHoursSchedule = Partial<Record<Weekday, BusinessHoursDay>>;

export interface HolidayEntry {
  /** "YYYY-MM-DD" (data fixa) ou "MM-DD"/"--MM-DD" (recorrente). */
  date: string;
  label?: string;
  /** Repete todo ano (equivale a informar só MM-DD). */
  annual?: boolean;
}

/** Subconjunto da Organization que o motor precisa. */
export interface ExpedienteOrg {
  businessHours247: boolean;
  businessTimezone: string;
  businessHoursSchedule: unknown;
  businessHolidays?: unknown;
  businessOutOfHoursMessage?: string | null;
}

const DEFAULT_TZ = 'America/Sao_Paulo';

// ─── Helpers de fuso (Intl, sem libs externas) ───────────────────────────
function tzFmt(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz || DEFAULT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

interface ZParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=domingo
  hour: number;
  minute: number;
}

export function tzParts(utcMs: number, tz: string): ZParts {
  const map: Record<string, string> = {};
  for (const p of tzFmt(tz).formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  let hour = +map.hour;
  if (hour === 24) hour = 0; // quirk do Intl (00:00 às vezes vem "24")
  return {
    year: +map.year,
    month: +map.month,
    day: +map.day,
    weekday: wd < 0 ? 0 : wd,
    hour,
    minute: +map.minute,
  };
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const p = tzParts(utcMs, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return asUTC - utcMs;
}

/** Horário de parede (na tz) → instante UTC (ms). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  return guess - tzOffsetMs(guess, tz);
}

function zonedStartOfDay(utcMs: number, tz: string): number {
  const { year, month, day } = tzParts(utcMs, tz);
  return zonedTimeToUtc(year, month, day, 0, 0, tz);
}

/** "HH:MM" → minutos do dia. Aceita "24:00" como 1440 (fim do dia). */
function parseHHMM(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map((v) => parseInt(v, 10));
  return (h || 0) * 60 + (m || 0);
}

// ─── Normalização da config ──────────────────────────────────────────────
export function normalizeSchedule(org: ExpedienteOrg): BusinessHoursSchedule {
  const raw = org.businessHoursSchedule;
  if (!raw || typeof raw !== 'object') return {};
  return raw as BusinessHoursSchedule;
}

export function getHolidays(org: ExpedienteOrg): HolidayEntry[] {
  const raw = org.businessHolidays;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (h): h is HolidayEntry => !!h && typeof (h as HolidayEntry).date === 'string',
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Um dia (na tz) é feriado? Casa data fixa (YYYY-MM-DD) ou anual (MM-DD). */
function isHoliday(
  year: number,
  month: number,
  day: number,
  holidays: HolidayEntry[],
): boolean {
  if (holidays.length === 0) return false;
  const full = `${year}-${pad2(month)}-${pad2(day)}`;
  const mmdd = `${pad2(month)}-${pad2(day)}`;
  return holidays.some((h) => {
    const d = h.date.trim().replace(/^--/, ''); // aceita "--MM-DD"
    if (d === full) return true;
    if ((h.annual || d.length <= 5) && d.slice(-5) === mmdd) return true;
    return false;
  });
}

export function getOutOfHoursMessage(org: ExpedienteOrg): string | null {
  const m = (org.businessOutOfHoursMessage ?? '').trim();
  return m.length > 0 ? m : null;
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Estamos DENTRO do expediente no instante `at`? */
export function isOpenAt(org: ExpedienteOrg, at: Date = new Date()): boolean {
  if (org.businessHours247) return true;
  const tz = org.businessTimezone || DEFAULT_TZ;
  const schedule = normalizeSchedule(org);
  // Config vazia + não-24/7 = provável má configuração → não bloqueia (abre).
  if (Object.keys(schedule).length === 0) return true;

  const p = tzParts(at.getTime(), tz);
  if (isHoliday(p.year, p.month, p.day, getHolidays(org))) return false;

  const cfg = schedule[DAY_INDEX[p.weekday]];
  if (!cfg || !cfg.enabled) return false;

  const windows = cfg.windows && cfg.windows.length > 0 ? cfg.windows : null;
  if (!windows) return true; // habilitado sem janelas = aberto o dia todo

  const nowMin = p.hour * 60 + p.minute;
  return windows.some(([from, to]) => {
    const f = parseHHMM(from);
    const t = parseHHMM(to);
    return nowMin >= f && nowMin < t;
  });
}

/**
 * Próximo instante (ms epoch) em que o expediente está aberto, a partir de
 * `fromMs`. Se já está aberto, devolve `fromMs`. 24/7 devolve `fromMs`.
 * Usado pelos salesbots pra empurrar o disparo pra dentro do horário.
 */
export function nextOpenFrom(org: ExpedienteOrg, fromMs: number = Date.now()): number {
  if (org.businessHours247) return fromMs;
  if (isOpenAt(org, new Date(fromMs))) return fromMs;

  const tz = org.businessTimezone || DEFAULT_TZ;
  const schedule = normalizeSchedule(org);
  if (Object.keys(schedule).length === 0) return fromMs;
  const holidays = getHolidays(org);

  let cursor = fromMs;
  for (let i = 0; i < 366; i++) {
    const p = tzParts(cursor, tz);
    if (!isHoliday(p.year, p.month, p.day, holidays)) {
      const cfg = schedule[DAY_INDEX[p.weekday]];
      if (cfg && cfg.enabled) {
        const windows =
          cfg.windows && cfg.windows.length > 0
            ? cfg.windows
            : ([['00:00', '24:00']] as Array<[string, string]>);
        const starts = windows
          .map(([f]) => parseHHMM(f))
          .sort((a, b) => a - b);
        for (const startMin of starts) {
          const winStart = zonedTimeToUtc(
            p.year,
            p.month,
            p.day,
            Math.floor(startMin / 60),
            startMin % 60,
            tz,
          );
          if (winStart >= fromMs) return winStart;
        }
      }
    }
    // Avança pro início do próximo dia local (26h evita quirk de DST).
    cursor = zonedStartOfDay(zonedStartOfDay(cursor, tz) + 26 * 3600000, tz);
  }
  return fromMs; // fallback improvável: sem janela num ano → não bloqueia
}

/**
 * Minutos de EXPEDIENTE entre dois instantes (para métricas de tempo de
 * resposta). Ignora madrugada/fim de semana/feriado fora da agenda.
 */
export function businessMinutesBetween(
  org: ExpedienteOrg,
  start: Date,
  end: Date,
): number {
  const s = start.getTime();
  const e = end.getTime();
  if (e <= s) return 0;
  if (org.businessHours247) return (e - s) / 60000;

  const tz = org.businessTimezone || DEFAULT_TZ;
  const schedule = normalizeSchedule(org);
  if (Object.keys(schedule).length === 0) return (e - s) / 60000;
  const holidays = getHolidays(org);

  let total = 0;
  let cursor = zonedStartOfDay(s, tz);
  for (let i = 0; i < 60 && cursor <= e; i++) {
    const p = tzParts(cursor, tz);
    if (!isHoliday(p.year, p.month, p.day, holidays)) {
      const cfg = schedule[DAY_INDEX[p.weekday]];
      if (cfg && cfg.enabled) {
        const windows =
          cfg.windows && cfg.windows.length > 0
            ? cfg.windows
            : ([['00:00', '24:00']] as Array<[string, string]>);
        for (const [from, to] of windows) {
          const fm = parseHHMM(from);
          const tm = parseHHMM(to);
          const winStart = zonedTimeToUtc(p.year, p.month, p.day, Math.floor(fm / 60), fm % 60, tz);
          const winEnd = zonedTimeToUtc(p.year, p.month, p.day, Math.floor(tm / 60), tm % 60, tz);
          const os = Math.max(s, winStart);
          const oe = Math.min(e, winEnd);
          if (oe > os) total += oe - os;
        }
      }
    }
    cursor = zonedStartOfDay(cursor + 26 * 3600000, tz);
  }
  return total / 60000;
}
