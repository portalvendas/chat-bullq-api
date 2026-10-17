import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MailService } from '../mail/mail.service';

/** Sincronização considerada parada depois de 2 h sem rodar com sucesso. */
const STALE_MS = 2 * 3600 * 1000;
/** Frequência da verificação. */
const CHECK_EVERY_MS = 15 * 60 * 1000;
/** Enquanto continuar parada, reavisa no máximo a cada 6 h. */
const REALERT_MS = 6 * 3600 * 1000;

/**
 * Alerta de sincronização do Tiny parada (ticket Fase 2 · E4).
 *
 * O envio de Purchase, AddToCart e QualifiedLead para a Meta roda DENTRO do
 * sync do Tiny — se o sync para, os três eventos param juntos, sem erro
 * visível. A cada 15 min, para cada integração ativa, compara o último sync
 * com sucesso (`lastPedidosSyncAt`, só avança quando a rodada termina bem) com
 * agora: passou de 2 h → e-mail para OWNER/ADMIN da organização, com o último
 * erro. Reaviso a cada 6 h enquanto durar; ao voltar, um e-mail de
 * normalização. Estado em memória (um restart pode repetir um aviso — aceitável).
 */
@Injectable()
export class TinySyncMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TinySyncMonitorService.name);
  private timer: NodeJS.Timeout | null = null;
  /** org → último aviso enviado (ms). Presente = incidente aberto. */
  private readonly alerted = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    // Primeira checagem após 5 min (dá tempo do cron do Tiny rodar no boot).
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
    setTimeout(() => void this.check(), 5 * 60 * 1000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    try {
      const integs = await this.prisma.tinyIntegration.findMany({
        where: { status: 'active' },
        select: {
          organizationId: true,
          lastPedidosSyncAt: true,
          lastError: true,
          organization: { select: { name: true } },
        },
      });
      const now = Date.now();
      for (const i of integs) {
        const last = i.lastPedidosSyncAt?.getTime() ?? 0;
        const stale = now - last > STALE_MS;
        const prev = this.alerted.get(i.organizationId);

        if (stale) {
          if (prev && now - prev < REALERT_MS) continue;
          this.alerted.set(i.organizationId, now);
          await this.notify(i.organizationId, {
            subject: `[Kortia] Sincronização do Tiny parada há ${hours(now - last)}`,
            body:
              `A sincronização do Tiny da organização ${esc(i.organization?.name ?? '')} não roda com sucesso desde ` +
              `${last ? fmt(i.lastPedidosSyncAt!) : 'nunca'}.<br><br>` +
              `Enquanto ela estiver parada, vendas (Purchase), orçamentos (AddToCart) e leads qualificados ` +
              `<b>não são enviados à Meta</b> e o painel de Pedidos &amp; Orçamentos não atualiza.<br><br>` +
              `Último erro: ${esc(i.lastError ?? 'nenhum registrado')}<br><br>` +
              `Verifique em Configurações → Integrações (Tiny) se a conexão está ativa e rode "Sincronizar agora".`,
          });
        } else if (prev) {
          this.alerted.delete(i.organizationId);
          await this.notify(i.organizationId, {
            subject: '[Kortia] Sincronização do Tiny normalizada',
            body: `A sincronização do Tiny voltou a rodar (último sucesso: ${fmt(i.lastPedidosSyncAt!)}). Os envios à Meta foram retomados.`,
          });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Monitor do sync Tiny falhou: ${err?.message ?? err}`);
    }
  }

  private async notify(organizationId: string, msg: { subject: string; body: string }) {
    const admins = await this.prisma.userOrganization.findMany({
      where: { organizationId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { user: { select: { email: true } } },
    });
    const to = [...new Set(admins.map((a) => a.user?.email).filter((e): e is string => !!e))];
    if (!to.length) {
      this.logger.warn(`Alerta do Tiny sem destinatário (org ${organizationId}): ${msg.subject}`);
      return;
    }
    const ok = await this.mail.send({
      to,
      subject: msg.subject,
      html: `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${msg.body}</p>`,
    });
    this.logger.log(`Alerta Tiny "${msg.subject}" → ${to.length} destinatário(s) ok=${ok}`);
  }
}

function hours(ms: number): string {
  if (!Number.isFinite(ms) || ms > 30 * 24 * 3600 * 1000) return 'muito tempo';
  return `${Math.floor(ms / 3600000)} h`;
}
function fmt(d: Date): string {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
