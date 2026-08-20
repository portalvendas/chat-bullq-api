import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Como cada passo mede as pendências a partir dos cards nas etapas mapeadas. */
type StepMetric = 'no_inbound' | 'has_inbound' | 'all';

export interface RoutineStep {
  key: string;
  label: string;
  /** Orientação exibida ao vendedor (o "como fazer"). */
  guidance: string;
  metric: StepMetric;
  /** Etapas (de qualquer funil) que este passo monitora. */
  stageIds: string[];
  /** Horas para considerar um lead "parado" nas etapas do passo. */
  thresholdHours: number;
  /** Se true, exige marcação manual (ex.: conferência por amostragem). */
  requireCheck: boolean;
  /** Palavras-chave para auto-sugerir etapas por nome (só no default). */
  nameMatch?: string[];
}

export interface RoutineConfigInput {
  enabled?: boolean;
  /** "ALL" = todos os membros; "SELECTED" = só os userIds listados. */
  userMode?: 'ALL' | 'SELECTED';
  userIds?: string[];
  /** Conta leads das etapas ignorando o responsável. */
  ignoreAssignment?: boolean;
  steps?: Array<
    Pick<RoutineStep, 'key' | 'stageIds' | 'thresholdHours' | 'requireCheck'> & {
      label?: string;
    }
  >;
}

/**
 * Passos padrão da rotina comercial (ordem = prioridade). Cada passo casa com
 * etapas do funil por palavra-chave na primeira vez; depois o admin ajusta.
 */
const DEFAULT_STEPS: RoutineStep[] = [
  {
    key: 'ENTRADA',
    label: 'Verificar leads na etapa de entrada',
    guidance:
      'Nenhum lead deve ficar parado na entrada — todos precisam ser contactados assim que chegam. Lead parado aqui pode indicar erro na automação de formulário.',
    metric: 'no_inbound',
    stageIds: [],
    thresholdHours: 1,
    requireCheck: false,
    nameMatch: ['entrada', 'novo lead', 'novos', 'entrantes'],
  },
  {
    key: 'FORA_EXPEDIENTE',
    label: 'Conferir contatos fora do horário de expediente',
    guidance:
      'Leads que chegam fora do horário e respondem à mensagem inicial precisam receber o catálogo ou outras informações. Verifique a etapa de follow-up inicial automático.',
    metric: 'has_inbound',
    stageIds: [],
    thresholdHours: 12,
    requireCheck: false,
    nameMatch: ['follow-up inicial', 'inicial autom', 'fora do horário', 'boas-vindas'],
  },
  {
    key: 'ORCAMENTO',
    label: 'Acompanhar leads que receberam orçamentos',
    guidance:
      'São os leads mais quentes e precisam de acompanhamento próximo. É o momento de colher informações e tratar objeções.',
    metric: 'all',
    stageIds: [],
    thresholdHours: 24,
    requireCheck: false,
    nameMatch: ['orçamento', 'orcamento', 'proposta', 'cotação'],
  },
  {
    key: 'FOLLOWUP_MANUAL',
    label: 'Gerenciar leads em Follow-up manual',
    guidance:
      'Leads em conversa com o atendimento que precisam ser retomados. Dê sequência ao contato.',
    metric: 'all',
    stageIds: [],
    thresholdHours: 48,
    requireCheck: false,
    nameMatch: ['follow-up manual', 'followup manual', 'manual'],
  },
  {
    key: 'FOLLOWUP_AUTO',
    label: 'Verificar Follow-up automático e inicial automático',
    guidance:
      'Mova leads ativos (que responderam) dessas etapas para "Follow-up manual". Confira por amostragem se as mensagens automáticas estão sendo enviadas e marque como conferido.',
    metric: 'has_inbound',
    stageIds: [],
    thresholdHours: 24,
    requireCheck: true,
    nameMatch: ['follow-up autom', 'followup autom', 'automático', 'automatico'],
  },
];

@Injectable()
export class CommercialRoutineService {
  private readonly logger = new Logger(CommercialRoutineService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Config ─────────────────────────────────────────────────────────

  /**
   * Config efetiva: se não há registro salvo, deriva os stageIds por nome das
   * etapas (auto-sugestão) para a org já nascer usável.
   */
  async getConfig(organizationId: string): Promise<{
    enabled: boolean;
    userMode: 'ALL' | 'SELECTED';
    userIds: string[];
    ignoreAssignment: boolean;
    steps: RoutineStep[];
  }> {
    const saved = await this.prisma.commercialRoutineConfig.findUnique({
      where: { organizationId },
    });
    if (saved) {
      const savedSteps = (saved.steps as unknown as RoutineStep[]) ?? [];
      // Mescla com os defaults para garantir label/guidance/metric atualizados.
      const steps = DEFAULT_STEPS.map((def) => {
        const s = savedSteps.find((x) => x.key === def.key);
        return {
          ...def,
          label: s?.label ?? def.label,
          stageIds: s?.stageIds ?? [],
          thresholdHours: s?.thresholdHours ?? def.thresholdHours,
          requireCheck: s?.requireCheck ?? def.requireCheck,
        };
      });
      return {
        enabled: saved.enabled,
        userMode: (saved.userMode as 'ALL' | 'SELECTED') ?? 'ALL',
        userIds: ((saved.userIds as unknown as string[]) ?? []).filter(Boolean),
        ignoreAssignment: saved.ignoreAssignment ?? false,
        steps,
      };
    }
    return {
      enabled: true,
      userMode: 'ALL',
      userIds: [],
      ignoreAssignment: false,
      steps: await this.autoSuggest(organizationId),
    };
  }

  /** A rotina está ativa para ESTE vendedor? (geral + escopo por usuário) */
  private isActiveForUser(
    cfg: { enabled: boolean; userMode: 'ALL' | 'SELECTED'; userIds: string[] },
    userId: string,
  ): boolean {
    if (!cfg.enabled) return false;
    return cfg.userMode === 'ALL' || cfg.userIds.includes(userId);
  }

  /** Deriva stageIds sugeridos casando o nome da etapa com as palavras-chave. */
  private async autoSuggest(organizationId: string): Promise<RoutineStep[]> {
    const stages = await this.prisma.pipelineStage.findMany({
      where: { pipeline: { organizationId, archived: false } },
      select: { id: true, name: true },
    });
    const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
    const norm = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(DIACRITICS, '');
    return DEFAULT_STEPS.map((def) => {
      const matches = stages
        .filter((st) =>
          (def.nameMatch ?? []).some((kw) => norm(st.name).includes(norm(kw))),
        )
        .map((st) => st.id);
      return { ...def, stageIds: matches };
    });
  }

  async updateConfig(organizationId: string, dto: RoutineConfigInput) {
    const current = await this.getConfig(organizationId);
    // Preserva metadados fixos (metric/guidance/nameMatch) e aplica o que veio.
    const steps: RoutineStep[] = DEFAULT_STEPS.map((def) => {
      const incoming = dto.steps?.find((s) => s.key === def.key);
      const existing = current.steps.find((s) => s.key === def.key);
      return {
        ...def,
        label: incoming?.label ?? existing?.label ?? def.label,
        stageIds: incoming?.stageIds ?? existing?.stageIds ?? [],
        thresholdHours:
          incoming?.thresholdHours ?? existing?.thresholdHours ?? def.thresholdHours,
        requireCheck:
          incoming?.requireCheck ?? existing?.requireCheck ?? def.requireCheck,
      };
    });
    const data = {
      enabled: dto.enabled ?? current.enabled,
      userMode: dto.userMode ?? current.userMode,
      userIds: (dto.userIds ?? current.userIds).filter(
        Boolean,
      ) as unknown as Prisma.InputJsonValue,
      ignoreAssignment: dto.ignoreAssignment ?? current.ignoreAssignment,
      steps: steps.map((s) => ({
        key: s.key,
        label: s.label,
        stageIds: [...new Set(s.stageIds.filter(Boolean))],
        thresholdHours: Number(s.thresholdHours) || 0,
        requireCheck: !!s.requireCheck,
      })) as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.commercialRoutineConfig.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    return this.getConfig(organizationId);
  }

  /** Funis + etapas para a tela de configuração (mapear passos → etapas). */
  async getOptions(organizationId: string) {
    const pipelines = await this.prisma.pipeline.findMany({
      where: { organizationId, archived: false },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        name: true,
        stages: {
          orderBy: { order: 'asc' },
          select: { id: true, name: true },
        },
      },
    });
    return { pipelines };
  }

  // ── Checklist do dia ───────────────────────────────────────────────

  /** Dia local YYYY-MM-DD no fuso America/Sao_Paulo (fecha o ciclo diário). */
  private today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
    }).format(new Date());
  }

  /**
   * Checklist do dia para UM vendedor: contadores por passo + estado de
   * conclusão (auto por contador + marcação manual). Agrega no servidor;
   * o frontend só renderiza.
   */
  async getToday(organizationId: string, userId: string) {
    const cfg = await this.getConfig(organizationId);
    const { steps } = cfg;
    const day = this.today();

    // Rotina desligada (geral) ou não aplicável a este vendedor → devolve vazio
    // e enabled=false. O frontend (tela + pop-up) já respeita esse enabled.
    const activeForUser = this.isActiveForUser(cfg, userId);
    if (!activeForUser) {
      return {
        day,
        enabled: false,
        steps: [],
        summary: {
          stepsTotal: 0,
          stepsDone: 0,
          totalPending: 0,
          totalParados: 0,
          firstPendingKey: null,
          allDone: true,
        },
      };
    }

    const checks = await this.prisma.routineDailyCheck.findMany({
      where: { organizationId, userId, day },
      select: { stepKey: true },
    });
    const checkedSet = new Set(checks.map((c) => c.stepKey));

    // Nomes das etapas referenciadas (para exibir no card do passo).
    const allStageIds = [...new Set(steps.flatMap((s) => s.stageIds))];
    const stageRows = allStageIds.length
      ? await this.prisma.pipelineStage.findMany({
          where: { id: { in: allStageIds } },
          select: { id: true, name: true, pipelineId: true },
        })
      : [];
    const stageName = new Map(stageRows.map((s) => [s.id, s.name]));

    const computed = await Promise.all(
      steps.map((step) =>
        this.computeStep(organizationId, userId, step, cfg.ignoreAssignment),
      ),
    );

    const outSteps = steps.map((step, i) => {
      const { total, pending, parados } = computed[i];
      const checked = checkedSet.has(step.key);
      const done = step.requireCheck
        ? checked
        : pending === 0 || checked;
      return {
        key: step.key,
        label: step.label,
        guidance: step.guidance,
        order: i + 1,
        metric: step.metric,
        total,
        pending,
        parados,
        thresholdHours: step.thresholdHours,
        requireCheck: step.requireCheck,
        checked,
        done,
        stageIds: step.stageIds,
        stages: step.stageIds
          .filter((id) => stageName.has(id))
          .map((id) => ({
            id,
            name: stageName.get(id)!,
            pipelineId: stageRows.find((s) => s.id === id)?.pipelineId ?? null,
          })),
      };
    });

    const stepsDone = outSteps.filter((s) => s.done).length;
    const firstPending = outSteps.find((s) => !s.done);
    return {
      day,
      enabled: true,
      steps: outSteps,
      summary: {
        stepsTotal: outSteps.length,
        stepsDone,
        totalPending: outSteps.reduce((a, s) => a + s.pending, 0),
        totalParados: outSteps.reduce((a, s) => a + s.parados, 0),
        firstPendingKey: firstPending?.key ?? null,
        allDone: stepsDone === outSteps.length,
      },
    };
  }

  /** Contadores de um passo para o vendedor (total / pendentes / parados). */
  private async computeStep(
    organizationId: string,
    userId: string,
    step: RoutineStep,
    ignoreAssignment = false,
  ): Promise<{ total: number; pending: number; parados: number }> {
    if (!step.stageIds.length) return { total: 0, pending: 0, parados: 0 };

    const { base, pendingWhere, paradoWhere } = this.stepWheres(
      organizationId,
      userId,
      step,
      ignoreAssignment,
    );

    try {
      const [total, pending, parados] = await Promise.all([
        this.prisma.card.count({ where: base }),
        step.metric === 'all'
          ? this.prisma.card.count({ where: base })
          : this.prisma.card.count({ where: pendingWhere }),
        this.prisma.card.count({ where: paradoWhere }),
      ]);
      return { total, pending, parados };
    } catch (err: any) {
      this.logger.warn(
        `computeStep ${step.key} falhou (org ${organizationId}): ${err?.message ?? err}`,
      );
      return { total: 0, pending: 0, parados: 0 };
    }
  }

  /** Marca/desmarca um passo como concluído no dia (idempotente). */
  async toggleCheck(
    organizationId: string,
    userId: string,
    stepKey: string,
    done: boolean,
  ) {
    const day = this.today();
    if (done) {
      await this.prisma.routineDailyCheck
        .create({ data: { organizationId, userId, day, stepKey } })
        .catch(() => undefined); // idempotente pelo unique
    } else {
      await this.prisma.routineDailyCheck.deleteMany({
        where: { organizationId, userId, day, stepKey },
      });
    }
    return this.getToday(organizationId, userId);
  }

  /**
   * Where de um passo (base / pendentes / parados) — MESMA lógica dos
   * contadores, extraída para reaproveitar na listagem exata de leads.
   */
  private stepWheres(
    organizationId: string,
    userId: string,
    step: RoutineStep,
    ignoreAssignment = false,
  ): {
    base: Prisma.CardWhereInput;
    pendingWhere: Prisma.CardWhereInput;
    paradoWhere: Prisma.CardWhereInput;
  } {
    const base: Prisma.CardWhereInput = {
      organizationId,
      ...(ignoreAssignment ? {} : { assignedToId: userId }),
      status: 'OPEN',
      stageId: { in: step.stageIds },
    };
    const hasInbound: Prisma.CardWhereInput = {
      conversation: { messages: { some: { direction: 'INBOUND' } } },
    };
    const noInbound: Prisma.CardWhereInput = {
      OR: [
        { conversationId: null },
        { conversation: { messages: { none: { direction: 'INBOUND' } } } },
      ],
    };
    const pendingWhere: Prisma.CardWhereInput =
      step.metric === 'has_inbound'
        ? { ...base, ...hasInbound }
        : step.metric === 'no_inbound'
          ? { ...base, ...noInbound }
          : base;
    const cutoff = new Date(Date.now() - step.thresholdHours * 3600_000);
    const paradoWhere: Prisma.CardWhereInput = {
      ...base,
      OR: [
        { conversation: { lastMessageAt: { lt: cutoff } } },
        { conversationId: null, updatedAt: { lt: cutoff } },
      ],
    };
    return { base, pendingWhere, paradoWhere };
  }

  /**
   * Lista EXATA de leads de um passo e estado — os MESMOS cards que geram o
   * contador da rotina (state='pending' = aguardando ação; 'parado' = parado).
   * Escopo = vendedor logado (idêntico ao checklist). stepKey vazio agrega
   * TODOS os passos (para os totais do topo). Pronto pro front renderizar.
   */
  async listStepLeads(
    organizationId: string,
    userId: string,
    stepKey: string | undefined,
    state: 'pending' | 'parado',
  ) {
    const cfg = await this.getConfig(organizationId);
    if (!this.isActiveForUser(cfg, userId)) {
      return { stepKey: stepKey ?? null, state, label: '', count: 0, leads: [] };
    }
    const targetSteps = stepKey
      ? cfg.steps.filter((s) => s.key === stepKey)
      : cfg.steps;

    const stageIds = [...new Set(targetSteps.flatMap((s) => s.stageIds))];
    const stageRows = stageIds.length
      ? await this.prisma.pipelineStage.findMany({
          where: { id: { in: stageIds } },
          select: { id: true, name: true, pipelineId: true },
        })
      : [];
    const stageInfo = new Map(stageRows.map((s) => [s.id, s]));

    const byId = new Map<string, Record<string, unknown>>();
    for (const step of targetSteps) {
      if (!step.stageIds.length) continue;
      const w = this.stepWheres(
        organizationId,
        userId,
        step,
        cfg.ignoreAssignment,
      );
      const where = state === 'parado' ? w.paradoWhere : w.pendingWhere;
      const cards = await this.prisma.card.findMany({
        where,
        select: {
          id: true,
          title: true,
          value: true,
          currency: true,
          stageId: true,
          contactId: true,
          conversationId: true,
          updatedAt: true,
          contact: { select: { id: true, name: true, phone: true } },
          conversation: { select: { id: true, lastMessageAt: true } },
          assignedTo: { select: { id: true, name: true } },
        },
        orderBy: [{ updatedAt: 'asc' }],
        take: 500,
      });
      for (const c of cards) {
        if (byId.has(c.id)) continue;
        const st = stageInfo.get(c.stageId);
        byId.set(c.id, {
          id: c.id,
          title: c.title,
          value: c.value != null ? Number(c.value) : null,
          currency: c.currency,
          stageId: c.stageId,
          stageName: st?.name ?? null,
          pipelineId: st?.pipelineId ?? null,
          contactId: c.contactId,
          contactName: c.contact?.name ?? null,
          contactPhone: c.contact?.phone ?? null,
          conversationId: c.conversationId ?? c.conversation?.id ?? null,
          lastActivityAt: c.conversation?.lastMessageAt ?? c.updatedAt,
          assignedToName: c.assignedTo?.name ?? null,
          stepKey: step.key,
        });
      }
    }

    const leads = [...byId.values()].sort(
      (a, b) =>
        new Date(a.lastActivityAt as string).getTime() -
        new Date(b.lastActivityAt as string).getTime(),
    );
    const label = stepKey
      ? (targetSteps[0]?.label ?? 'Passo')
      : state === 'parado'
        ? 'Leads parados'
        : 'Leads aguardando ação';
    return { stepKey: stepKey ?? null, state, label, count: leads.length, leads };
  }

  // ── Log gerencial (execução da rotina) ─────────────────────────────

  /** Soma `delta` dias a um YYYY-MM-DD (aritmética de calendário em UTC). */
  private shiftDay(day: string, delta: number): string {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  }

  /** Lista de dias YYYY-MM-DD de `from` a `to` inclusive (cap defensivo). */
  private dayRange(from: string, to: string): string[] {
    const out: string[] = [];
    let cur = from;
    let guard = 0;
    while (cur <= to && guard < 400) {
      out.push(cur);
      cur = this.shiftDay(cur, 1);
      guard++;
    }
    return out;
  }

  /**
   * Log gerencial: quem executou o checklist e quando. Agrega as marcações
   * (RoutineDailyCheck) por vendedor e por dia no intervalo pedido (default:
   * últimos 14 dias). `perUser` traz a aderência recente (today/yesterday/
   * stale/never pela última marcação de qualquer época) e `history` a grade
   * dia × vendedor para o front desenhar. Só OWNER/ADMIN consomem.
   */
  async getExecutionLog(
    organizationId: string,
    from?: string,
    to?: string,
    userId?: string,
  ) {
    const cfg = await this.getConfig(organizationId);
    const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const toDay = isDay(to) ? (to as string) : this.today();
    const fromRaw = isDay(from) ? (from as string) : this.shiftDay(toDay, -13);
    const range =
      fromRaw <= toDay
        ? { from: fromRaw, to: toDay }
        : { from: toDay, to: fromRaw };

    // Grade de dias (cap defensivo de 92 dias, mantendo os mais recentes).
    const MAX_DAYS = 92;
    let dayList = this.dayRange(range.from, range.to);
    if (dayList.length > MAX_DAYS) {
      dayList = dayList.slice(dayList.length - MAX_DAYS);
      range.from = dayList[0];
    }

    // Vendedores aplicáveis (respeita escopo da config + filtro opcional).
    const members = await this.prisma.userOrganization.findMany({
      where: { organizationId },
      select: { user: { select: { id: true, name: true, isActive: true } } },
    });
    let applicable = members.map((m) => m.user);
    if (cfg.userMode === 'SELECTED') {
      const allow = new Set(cfg.userIds);
      applicable = applicable.filter((u) => allow.has(u.id));
    }
    if (userId) applicable = applicable.filter((u) => u.id === userId);
    const applicableIds = applicable.map((u) => u.id);

    // Marcações por (dia, vendedor) dentro do intervalo → grade.
    const grouped = applicableIds.length
      ? await this.prisma.routineDailyCheck.groupBy({
          by: ['day', 'userId'],
          where: {
            organizationId,
            userId: { in: applicableIds },
            day: { gte: range.from, lte: range.to },
          },
          _count: { _all: true },
        })
      : [];
    const countAt = new Map(
      grouped.map((g) => [`${g.day}|${g.userId}`, g._count._all]),
    );

    // Última marcação de cada vendedor (qualquer época) → status de aderência.
    const lastRows = applicableIds.length
      ? await this.prisma.routineDailyCheck.groupBy({
          by: ['userId'],
          where: { organizationId, userId: { in: applicableIds } },
          _max: { day: true },
        })
      : [];
    const lastDayByUser = new Map(
      lastRows.map((r) => [r.userId, r._max.day ?? null]),
    );

    const today = this.today();
    const yesterday = this.shiftDay(today, -1);
    const rank: Record<string, number> = {
      today: 0,
      yesterday: 1,
      stale: 2,
      never: 3,
    };

    const perUser = applicable
      .map((u) => {
        const lastDay = lastDayByUser.get(u.id) ?? null;
        const status = !lastDay
          ? 'never'
          : lastDay >= today
            ? 'today'
            : lastDay === yesterday
              ? 'yesterday'
              : 'stale';
        let totalChecks = 0;
        let daysActive = 0;
        for (const day of dayList) {
          const c = countAt.get(`${day}|${u.id}`) ?? 0;
          if (c > 0) {
            totalChecks += c;
            daysActive += 1;
          }
        }
        return {
          userId: u.id,
          name: u.name,
          isActive: u.isActive,
          lastDay,
          status,
          totalChecks,
          daysActive,
        };
      })
      .sort((a, b) => {
        if (rank[a.status] !== rank[b.status])
          return rank[a.status] - rank[b.status];
        return (a.name || '').localeCompare(b.name || '');
      });

    const history = dayList.map((day) => ({
      day,
      perUser: applicable.map((u) => ({
        userId: u.id,
        count: countAt.get(`${day}|${u.id}`) ?? 0,
      })),
    }));

    return {
      range,
      enabled: cfg.enabled,
      stepsTotal: cfg.steps.length,
      users: applicable.map((u) => ({
        id: u.id,
        name: u.name,
        isActive: u.isActive,
      })),
      perUser,
      history,
    };
  }
}
