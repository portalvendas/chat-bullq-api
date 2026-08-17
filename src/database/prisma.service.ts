import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getTenantContext } from '../common/tenant/tenant-context';
import {
  TENANT_MODELS,
  SET_ACTIONS,
  whereMentionsOrg,
} from '../common/tenant/tenant-models';
import {
  encryptChannelWriteData,
  decryptChannelResult,
  isEncryptionEnabled,
} from '../common/crypto/secret-cipher';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.registerTenantGuard();
    this.registerChannelCrypto();
    await this.$connect();
    this.logger.log('Database connected');
  }

  /**
   * Tenant-guard (defesa em profundidade multi-empresa) — MODO OBSERVAÇÃO.
   * Quando há org no contexto do request (OrgGuard) e uma query de conjunto
   * (findMany/updateMany/deleteMany/count/aggregate/groupBy) roda num modelo
   * de tenant SEM filtrar por organizationId, apenas LOGA um warning — não
   * altera nem bloqueia a query. Serve pra caçar vazamentos reais nos logs
   * antes de ligar o bloqueio. Jobs/crons (sem contexto de request) não são
   * afetados. TODO: migrar de $use (deprecado) p/ client extension e, após
   * validar os logs, passar a INJETAR o organizationId / lançar erro.
   */
  private registerTenantGuard(): void {
    this.$use(async (params: any, next: (p: any) => Promise<any>) => {
      try {
        const orgId = getTenantContext()?.organizationId;
        if (
          orgId &&
          params.model &&
          TENANT_MODELS.has(params.model) &&
          SET_ACTIONS.has(params.action)
        ) {
          const where =
            (params.args && (params.args.where ?? params.args)) || {};
          if (!whereMentionsOrg(where)) {
            this.logger.warn(
              `[tenant-guard][observacao] ${params.model}.${params.action} sem organizationId (org do request=${orgId}) — potencial vazamento cross-tenant`,
            );
          }
        }
      } catch {
        // o guard NUNCA pode derrubar a query
      }
      return next(params);
    });
  }

  /**
   * Cifragem de segredos do canal em repouso (AES-256-GCM) — TRANSPARENTE.
   * Cifra `config`/`webhookSecret` na ESCRITA e decifra na LEITURA, no mesmo
   * ponto (middleware) que já intercepta todas as operações do modelo Channel.
   * Assim nenhum adapter/repository precisa mudar. Chave em ENCRYPTION_KEY;
   * sem a env, vira no-op (texto puro) — ver secret-cipher.ts. Raw SQL não
   * passa por aqui, mas `channels` nunca é lido via $queryRaw no projeto.
   */
  private registerChannelCrypto(): void {
    if (!isEncryptionEnabled()) {
      this.logger.warn(
        '[secret-cipher] ENCRYPTION_KEY ausente — segredos de canal ficam em texto puro (cifragem desligada)',
      );
    }
    const WRITE_DATA = new Set(['create', 'update', 'createMany', 'updateMany']);
    const RETURN_ROWS = new Set([
      'findMany',
      'findFirst',
      'findFirstOrThrow',
      'findUnique',
      'findUniqueOrThrow',
      'create',
      'update',
      'delete',
    ]);
    this.$use(async (params: any, next: (p: any) => Promise<any>) => {
      if (params.model !== 'Channel') return next(params);
      try {
        if (params.args?.data && WRITE_DATA.has(params.action)) {
          params.args.data = encryptChannelWriteData(params.args.data);
        } else if (params.action === 'upsert' && params.args) {
          if (params.args.create)
            params.args.create = encryptChannelWriteData(params.args.create);
          if (params.args.update)
            params.args.update = encryptChannelWriteData(params.args.update);
        }
      } catch (err: any) {
        this.logger.error(
          `[secret-cipher] falha ao cifrar Channel.${params.action}: ${err?.message}`,
        );
        throw err; // nunca gravar segredo achando que cifrou
      }
      const result = await next(params);
      if (params.action === 'upsert' || RETURN_ROWS.has(params.action)) {
        try {
          return decryptChannelResult(result);
        } catch (err: any) {
          this.logger.error(
            `[secret-cipher] falha ao decifrar Channel.${params.action}: ${err?.message}`,
          );
          return result;
        }
      }
      return result;
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }
}
