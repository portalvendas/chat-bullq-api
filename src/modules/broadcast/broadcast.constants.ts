/** Filas BullMQ e chaves do módulo de disparos. */
export const BROADCAST_SEND_QUEUE = 'broadcast-send';
export const BROADCAST_SEND_JOB = 'send-recipient';

export const CONTACT_IMPORT_QUEUE = 'contact-import';
export const CONTACT_IMPORT_JOB = 'process-import';

export const BROADCAST_RECONCILE_QUEUE = 'broadcast-reconcile';
export const BROADCAST_RECONCILE_JOB = 'reconcile-scan';

/** Módulo RBAC. `view` = ver/estimar; `edit` = disparar (gasta e afeta o número). */
export const DISPAROS_MODULE = 'disparos';

/** 1 BRL = 1.000.000 micros (utility é sub-centavo; soma de 100k estoura Int32). */
export const MICROS_PER_BRL = 1_000_000n;
