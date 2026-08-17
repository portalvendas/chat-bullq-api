import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
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

const cryptoLogger = new Logger('secret-cipher');
const guardLogger = new Logger('tenant-guard');

// Ações de escrita cujo `data` pode conter segredos do canal.
const WRITE_DATA = new Set(['create', 'update', 'createMany', 'updateMany']);
// Ações que retornam linha(s) de Channel — precisam ser decifradas na volta.
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

/**
 * PrismaService — cliente Prisma da aplicação com DUAS extensões (client
 * extension `$extends`, pois o `$use`/middleware foi REMOVIDO no Prisma 6):
 *
 *  1. tenant-guard (defesa em profundidade multi-empresa, MODO OBSERVAÇÃO):
 *     quando há org no contexto do request e uma query de CONJUNTO roda num
 *     modelo de tenant SEM filtrar por organizationId, apenas LOGA um warning
 *     (não altera nem bloqueia). Serve pra caçar vazamentos reais nos logs
 *     antes de ligar o bloqueio. Jobs/crons (sem request) não são afetados.
 *
 *  2. secret-cipher (cifragem de segredos do canal em repouso, AES-256-GCM):
 *     cifra `config`/`webhookSecret` na ESCRITA e decifra na LEITURA, de forma
 *     transparente — nenhum adapter/repository muda. Chave em ENCRYPTION_KEY;
 *     sem a env vira no-op (texto puro). Raw SQL não passa por extensão, mas
 *     `channels` nunca é lido via $queryRaw no projeto.
 *
 * Wiring: `$extends` devolve um cliente NOVO (não muta `this`). Como toda a
 * app injeta PrismaService e usa `this.prisma.<model>`, o construtor devolve
 * um Proxy que delega ao cliente estendido para tudo que ele conhece
 * (delegates de modelo, $connect, $transaction, etc.) e mantém no `this` os
 * métodos da própria classe (onModuleInit/onModuleDestroy/logger).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly extended: PrismaClient;

  constructor() {
    super();

    if (!isEncryptionEnabled()) {
      cryptoLogger.warn(
        'ENCRYPTION_KEY ausente — segredos de canal ficam em texto puro (cifragem desligada)',
      );
    }

    this.extended = this.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }: any) {
            // (1) tenant-guard — só observa/loga, nunca derruba a query.
            try {
              const orgId = getTenantContext()?.organizationId;
              if (
                orgId &&
                model &&
                TENANT_MODELS.has(model) &&
                SET_ACTIONS.has(operation)
              ) {
                const where = (args && (args.where ?? args)) || {};
                if (!whereMentionsOrg(where)) {
                  guardLogger.warn(
                    `[observacao] ${model}.${operation} sem organizationId (org do request=${orgId}) — potencial vazamento cross-tenant`,
                  );
                }
              }
            } catch {
              // o guard NUNCA pode derrubar a query
            }

            // (2) secret-cipher — só no modelo Channel.
            if (model === 'Channel') {
              try {
                if (args?.data && WRITE_DATA.has(operation)) {
                  args.data = encryptChannelWriteData(args.data);
                } else if (operation === 'upsert' && args) {
                  if (args.create)
                    args.create = encryptChannelWriteData(args.create);
                  if (args.update)
                    args.update = encryptChannelWriteData(args.update);
                }
              } catch (err: any) {
                cryptoLogger.error(
                  `falha ao cifrar Channel.${operation}: ${err?.message}`,
                );
                throw err; // nunca gravar segredo achando que cifrou
              }

              const result = await query(args);

              if (operation === 'upsert' || RETURN_ROWS.has(operation)) {
                try {
                  return decryptChannelResult(result);
                } catch (err: any) {
                  cryptoLogger.error(
                    `falha ao decifrar Channel.${operation}: ${err?.message}`,
                  );
                  return result;
                }
              }
              return result;
            }

            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    // Delega tudo que o cliente estendido conhece (modelos, $connect,
    // $transaction, $queryRaw...) e mantém os métodos da classe no target.
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        const ext = (target as PrismaService).extended as any;
        if (ext && prop in ext && prop !== 'extended') {
          const value = ext[prop];
          return typeof value === 'function' ? value.bind(ext) : value;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }
}
