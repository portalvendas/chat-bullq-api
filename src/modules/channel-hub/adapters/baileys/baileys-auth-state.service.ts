/**
 * Auth-state do Baileys persistido no Postgres (creds + signal keys num único
 * blob JSON por canal, via BufferJSON). Suficiente para 1 número por canal.
 *
 * ⚠️ Este arquivo importa `@whiskeysockets/baileys` (dependência a ser
 * adicionada no Mac com `yarn add`). NÃO é typechecado neste ambiente — validar
 * com `tsc` local após o `yarn add`.
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  AuthenticationCreds,
  AuthenticationState,
} from '@whiskeysockets/baileys';
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { PrismaService } from '../../../../database/prisma.service';

type KeyStore = Record<string, Record<string, any>>;

/** Janela pra agrupar rajadas de keys.set numa única gravação. */
const KEYS_FLUSH_DEBOUNCE_MS = 1000;

@Injectable()
export class BaileysAuthStateService {
  private readonly logger = new Logger(BaileysAuthStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Carrega (ou inicializa) o auth-state de um canal e devolve `{ state,
   * saveCreds }` no formato que o `makeWASocket` espera.
   */
  async load(channelId: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    const row = await this.prisma.whatsappBaileysSession.findUnique({
      where: { channelId },
    });

    const creds: AuthenticationCreds = row?.creds
      ? JSON.parse(JSON.stringify(row.creds), BufferJSON.reviver)
      : initAuthCreds();
    const keys: KeyStore = row?.keys
      ? JSON.parse(JSON.stringify(row.keys), BufferJSON.reviver)
      : {};

    // Grava o blob inteiro (creds + keys) — UMA escrita.
    const writeNow = async () => {
      try {
        const credsJson = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
        const keysJson = JSON.parse(JSON.stringify(keys, BufferJSON.replacer));
        await this.prisma.whatsappBaileysSession.upsert({
          where: { channelId },
          create: { channelId, creds: credsJson, keys: keysJson },
          update: { creds: credsJson, keys: keysJson },
        });
      } catch (e: any) {
        this.logger.error(`persist auth channel=${channelId}: ${e?.message ?? e}`);
      }
    };

    /*
     * Coalescência (single-flight por canal). Antes, CADA keys.set disparava um
     * upsert do blob inteiro em paralelo; numa reconexão/sync de histórico o
     * Baileys chama keys.set centenas de vezes em segundos → centenas de
     * upserts simultâneos esgotavam o pool do Prisma (5 conexões) e travavam a
     * API inteira (login, webhooks, outbox). Agora: no máximo 1 escrita em voo
     * por canal; chamadas durante a escrita só marcam "dirty" e geram UMA
     * regravação no fim, já com o estado mais recente (o blob é sempre o
     * estado completo em memória, então nada se perde).
     */
    let inFlight: Promise<void> | null = null;
    let dirty = false;
    let timer: NodeJS.Timeout | null = null;

    const flush = (): Promise<void> => {
      if (inFlight) {
        dirty = true;
        return inFlight;
      }
      inFlight = (async () => {
        do {
          dirty = false;
          await writeNow();
        } while (dirty);
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };

    // keys.set: agrupa rajadas numa janela curta antes de gravar.
    const scheduleFlush = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, KEYS_FLUSH_DEBOUNCE_MS);
    };

    // creds.update: grava já (coalescido) — creds são críticos pra reconexão.
    const persist = async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    };

    const state: AuthenticationState = {
      creds,
      keys: {
        get: (type: string, ids: string[]) => {
          const cat = keys[type] || {};
          const out: Record<string, any> = {};
          for (const id of ids) {
            let val = cat[id];
            if (type === 'app-state-sync-key' && val) {
              val = proto.Message.AppStateSyncKeyData.fromObject(val);
            }
            if (val !== undefined) out[id] = val;
          }
          return out;
        },
        set: (data: Record<string, Record<string, any>>) => {
          for (const category of Object.keys(data)) {
            keys[category] = keys[category] || {};
            const entries = data[category] || {};
            for (const id of Object.keys(entries)) {
              const v = entries[id];
              if (v) keys[category][id] = v;
              else delete keys[category][id];
            }
          }
          // Agrupado (debounce + single-flight); o creds.update também força flush.
          scheduleFlush();
        },
      } as AuthenticationState['keys'],
    };

    return { state, saveCreds: persist };
  }

  async clear(channelId: string): Promise<void> {
    await this.prisma.whatsappBaileysSession
      .deleteMany({ where: { channelId } })
      .catch(() => undefined);
  }
}
