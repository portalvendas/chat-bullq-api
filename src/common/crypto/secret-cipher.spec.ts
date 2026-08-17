import {
  resetKeyCache,
  isEncryptionEnabled,
  isEncrypted,
  encryptString,
  decryptString,
  encryptConfig,
  decryptConfig,
  encryptChannelWriteData,
  decryptChannelRow,
  decryptChannelResult,
} from './secret-cipher';

describe('secret-cipher', () => {
  const KEY = 'unit-test-encryption-key';
  const cfg = { accessToken: 'abc', igBusinessId: '123', nested: { a: 1 } };

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    resetKeyCache();
  });

  describe('sem ENCRYPTION_KEY (desligado)', () => {
    beforeEach(() => {
      delete process.env.ENCRYPTION_KEY;
      resetKeyCache();
    });

    it('fica desabilitado e passa tudo em texto puro', () => {
      expect(isEncryptionEnabled()).toBe(false);
      expect(encryptString('hello')).toBe('hello');
      expect(encryptConfig(cfg)).toBe(cfg);
      const wd = encryptChannelWriteData({ config: cfg, webhookSecret: 's' });
      expect(wd.config).toBe(cfg);
      expect(wd.webhookSecret).toBe('s');
    });
  });

  describe('com ENCRYPTION_KEY (ligado)', () => {
    beforeEach(() => {
      process.env.ENCRYPTION_KEY = KEY;
      resetKeyCache();
    });

    it('cifra string com envelope enc:v1: e faz round-trip', () => {
      const enc = encryptString('hello');
      expect(isEncrypted(enc)).toBe(true);
      expect(enc.startsWith('enc:v1:')).toBe(true);
      expect(decryptString(enc)).toBe('hello');
    });

    it('encryptString é idempotente', () => {
      const enc = encryptString('hello');
      expect(encryptString(enc)).toBe(enc);
    });

    it('cifra config em { __enc } e faz round-trip preservando nested', () => {
      const ec = encryptConfig(cfg) as Record<string, unknown>;
      expect(Object.keys(ec)).toEqual(['__enc']);
      expect(isEncrypted(ec.__enc)).toBe(true);
      expect(decryptConfig(ec)).toEqual(cfg);
    });

    it('encryptConfig é idempotente', () => {
      const ec = encryptConfig(cfg);
      expect(encryptConfig(ec)).toBe(ec);
    });

    it('IVs diferentes geram ciphertexts diferentes (não determinístico)', () => {
      expect(encryptString('hello')).not.toBe(encryptString('hello'));
    });

    it('write→read de canal cifra e decifra os dois campos', () => {
      const wd = encryptChannelWriteData({
        config: cfg,
        webhookSecret: 'whsec_1',
        name: 'x',
      });
      expect((wd.config as Record<string, unknown>).__enc).toBeDefined();
      expect(isEncrypted(wd.webhookSecret)).toBe(true);
      expect(wd.name).toBe('x'); // outros campos intactos
      const row = decryptChannelRow({
        id: 'c1',
        config: wd.config,
        webhookSecret: wd.webhookSecret,
      });
      expect(row.config).toEqual(cfg);
      expect(row.webhookSecret).toBe('whsec_1');
    });

    it('linha legada em texto puro passa sem alteração', () => {
      const legacy = { id: 'c2', config: cfg, webhookSecret: 'plain' };
      expect(decryptChannelRow(legacy)).toBe(legacy);
    });

    it('decryptChannelResult lida com array, objeto e null', () => {
      const wd = encryptChannelWriteData({ config: cfg, webhookSecret: null });
      const arr = decryptChannelResult([
        { config: wd.config, webhookSecret: null },
        { config: cfg, webhookSecret: null },
      ]) as any[];
      expect(arr[0].config).toEqual(cfg);
      expect(arr[1].config).toEqual(cfg);
      expect(decryptChannelResult(null)).toBeNull();
    });

    it('chave errada não decifra e NÃO lança (mantém envelope)', () => {
      const ec = encryptConfig(cfg);
      process.env.ENCRYPTION_KEY = 'outra-chave-diferente';
      resetKeyCache();
      expect(decryptConfig(ec)).toBe(ec);
    });
  });
});
