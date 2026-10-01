/**
 * Extrator DETERMINÍSTICO de dados de cadastro a partir das mensagens do lead.
 * Sem IA: regex + validação. Alta precisão (evita falso-positivo) — o que não
 * dá pra ter certeza, não preenche. Dois formatos suportados:
 *   1) Bloco ROTULADO ("Nome: …\nCPF/CNPJ: …\nE-mail: …") — o lead preenche o modelo.
 *   2) Valores SOLTOS em mensagens separadas (CPF, e-mail, CEP, data, nome).
 */

export interface CadastroData {
  name?: string;
  email?: string;
  cpfCnpj?: string; // só dígitos
  birthDate?: string; // dd/mm/aaaa (como veio, normalizado p/ 4 dígitos no ano)
  cep?: string; // só dígitos (8)
  estado?: string; // UF (2 letras maiúsc.)
  cidade?: string;
  bairro?: string;
  endereco?: string;
  numero?: string;
  complemento?: string;
  addressText?: string; // endereço "cru" quando vem solto (não rotulado)
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const CEP_RE = /\b(\d{5})-(\d{3})\b/; // só com hífen = alta confiança
const DATE_ONLY_RE = /^\s*(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s*$/;

/** Palavras que NÃO são nome (evita capturar saudações como nome). */
const NOT_NAME = new Set([
  'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'sim', 'nao',
  'não', 'ok', 'certo', 'blz', 'beleza', 'ola', 'olá', 'oi', 'por', 'favor',
  'como', 'vai', 'tudo', 'bem', 'valeu', 'perfeito', 'show', 'otimo', 'ótimo',
  'quero', 'queria', 'preciso', 'gostaria', 'pode', 'ser', 'aqui', 'esta',
  'está', 'estao', 'estão', 'segue', 'em', 'anexo', 'comprovante', 'pago',
  'pagamento', 'recibo', 'link', 'produto', 'pedido', 'medidas',
]);

function onlyDigits(v: string): string {
  return (v ?? '').replace(/\D/g, '');
}

/** Validação de CPF (dígitos verificadores) — descarta números aleatórios. */
export function isValidCpf(cpf: string): boolean {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(d[i], 10) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === parseInt(d[9], 10) && calc(10) === parseInt(d[10], 10);
}

/** Validação de CNPJ (dígitos verificadores). */
export function isValidCnpj(cnpj: string): boolean {
  const d = onlyDigits(cnpj);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(d[i], 10) * w[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === parseInt(d[12], 10) && calc(13) === parseInt(d[13], 10);
}

function deburr(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Um texto solto parece um NOME completo de pessoa? (2–5 palavras, só letras). */
function looksLikeName(text: string): boolean {
  const t = text.trim();
  if (t.length < 6 || t.length > 60) return false;
  if (/[\d@:/]/.test(t)) return false; // nome não tem dígito/@/:
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  for (const w of words) {
    if (!/^[A-Za-zÀ-ÿ'.-]+$/.test(w)) return false;
    if (NOT_NAME.has(deburr(w).toLowerCase())) return false;
  }
  return true;
}

/** Acha um CPF (11) ou CNPJ (14) válido no texto. */
function findDocument(text: string): string | undefined {
  // candidatos: sequências com pontuação típica ou 11/14 dígitos corridos
  const matches = text.match(/\d[\d.\-/]{9,16}\d/g) ?? [];
  for (const m of matches) {
    const d = onlyDigits(m);
    if (d.length === 11 && isValidCpf(d)) return d;
    if (d.length === 14 && isValidCnpj(d)) return d;
  }
  return undefined;
}

/** Normaliza o ano da data (dd/mm/aa → dd/mm/19aa|20aa). */
function normalizeDate(d: string, m: string, y: string): string {
  let year = y;
  if (y.length === 2) {
    const n = parseInt(y, 10);
    year = (n > 30 ? '19' : '20') + y.padStart(2, '0');
  }
  return `${d}/${m}/${year}`;
}

/** Mapa de rótulo normalizado → campo. */
function labelToField(raw: string): keyof CadastroData | null {
  const k = deburr(raw).toLowerCase().replace(/[^a-z/ ]/g, '').trim();
  if (k === 'nome') return 'name';
  if (k === 'cpf' || k === 'cnpj' || k === 'cpf/cnpj' || k === 'cpfcnpj' || k === 'documento') return 'cpfCnpj';
  if (k.startsWith('data de nasc') || k === 'nascimento' || k === 'data nascimento' || k === 'nasc') return 'birthDate';
  if (k === 'cep') return 'cep';
  if (k === 'estado' || k === 'uf') return 'estado';
  if (k === 'cidade' || k === 'municipio') return 'cidade';
  if (k === 'bairro') return 'bairro';
  if (k === 'endereco' || k === 'rua' || k === 'logradouro') return 'endereco';
  if (k === 'numero' || k === 'num' || k === 'n') return 'numero';
  if (k === 'complemento' || k === 'compl') return 'complemento';
  if (k === 'email' || k === 'e-mail' || k === 'e mail') return 'email';
  return null;
}

/** Parse do bloco ROTULADO (uma ou várias linhas "Rótulo: valor"). */
function parseLabeled(text: string): CadastroData {
  const out: CadastroData = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-zÀ-ÿ/ ().-]{2,30})\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const field = labelToField(m[1]);
    const value = m[2].trim();
    if (!field || !value) continue; // "Nome:" sem valor (modelo) é ignorado
    applyValue(out, field, value);
  }
  return out;
}

/** Aplica um valor bruto ao campo, com a normalização de cada tipo. */
function applyValue(out: CadastroData, field: keyof CadastroData, value: string): void {
  switch (field) {
    case 'cpfCnpj': {
      const doc = findDocument(value) ?? (onlyDigits(value).length >= 11 ? onlyDigits(value) : undefined);
      if (doc && (isValidCpf(doc) || isValidCnpj(doc))) out.cpfCnpj = doc;
      break;
    }
    case 'email': {
      const e = value.match(EMAIL_RE)?.[0];
      if (e) out.email = e.toLowerCase();
      break;
    }
    case 'cep': {
      const d = onlyDigits(value);
      if (d.length === 8) out.cep = d;
      break;
    }
    case 'estado': {
      const uf = deburr(value).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
      if (uf.length === 2) out.estado = uf;
      break;
    }
    case 'birthDate': {
      const dm = value.match(/(\d{2})\/(\d{2})\/(\d{2}|\d{4})/);
      if (dm) out.birthDate = normalizeDate(dm[1], dm[2], dm[3]);
      break;
    }
    default:
      if (value) (out as any)[field] = value;
  }
}

/** Parse de UMA mensagem SOLTA (sem rótulos). */
function parseLoose(text: string): CadastroData {
  const out: CadastroData = {};
  const trimmed = text.trim();

  const email = text.match(EMAIL_RE)?.[0];
  if (email) out.email = email.toLowerCase();

  const doc = findDocument(text);
  if (doc) out.cpfCnpj = doc;

  const cep = text.match(CEP_RE);
  if (cep) out.cep = cep[1] + cep[2];

  const dOnly = trimmed.match(DATE_ONLY_RE);
  if (dOnly) out.birthDate = normalizeDate(dOnly[1], dOnly[2], dOnly[3]);

  // Nome só quando a mensagem INTEIRA parece um nome (sem outros dados).
  if (!email && !doc && !cep && !dOnly && looksLikeName(trimmed)) {
    out.name = trimmed.replace(/\s+/g, ' ');
  }

  // Endereço solto: linha com CEP + logradouro típico → guarda o texto cru.
  if (!out.name && (cep || /\b(rua|r\.|avenida|av\.|travessa|rodovia|alameda|pra[çc]a)\b/i.test(text))) {
    const addr = trimmed.replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ');
    if (addr.length >= 8 && addr.length <= 200) out.addressText = addr;
  }

  return out;
}

/** Mescla b em a SEM sobrescrever o que já existe em a. */
function mergeFillEmpty(a: CadastroData, b: CadastroData): void {
  for (const k of Object.keys(b) as (keyof CadastroData)[]) {
    if (a[k] == null && b[k] != null) a[k] = b[k];
  }
}

/** Extrai os dados de UMA mensagem (rotulado tem prioridade sobre solto). */
export function extractFromText(text: string): CadastroData {
  if (!text || !text.trim()) return {};
  const labeled = parseLabeled(text);
  const loose = parseLoose(text);
  // Num bloco ROTULADO, o addressText (fallback "cru") seria o bloco inteiro —
  // é ruído. Só vale para mensagem solta sem rótulos.
  if (Object.keys(labeled).length > 0) delete loose.addressText;
  const out: CadastroData = { ...labeled };
  mergeFillEmpty(out, loose);
  return out;
}

/**
 * Extrai e CONSOLIDA os dados de VÁRIAS mensagens (ex.: valores soltos em
 * mensagens separadas). Primeiro valor válido de cada campo vence.
 */
export function extractFromMessages(texts: string[]): CadastroData {
  const out: CadastroData = {};
  for (const t of texts) mergeFillEmpty(out, extractFromText(t));
  return out;
}
