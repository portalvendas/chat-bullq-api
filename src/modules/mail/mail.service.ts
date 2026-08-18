import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

/**
 * Envio de e-mail transacional via Resend (API HTTP direta, sem SDK — evita
 * dependência nova). Segredos e remetente vêm de env:
 *   - RESEND_API_KEY : chave da API (obrigatória p/ enviar de verdade)
 *   - MAIL_FROM      : remetente verificado no Resend (ex.: "ChatBullQ <no-reply@seu-dominio>")
 *   - WEB_APP_URL    : base do app web (pra montar links, ex.: convite)
 *
 * Degradação segura: sem RESEND_API_KEY, NÃO lança — loga um warn e devolve
 * false (o fluxo que chamou continua). Nunca derruba a request de negócio.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  private get apiKey(): string | undefined {
    const k = process.env.RESEND_API_KEY;
    return k && k.trim() ? k.trim() : undefined;
  }

  private get from(): string {
    return process.env.MAIL_FROM || 'ChatBullQ <onboarding@resend.dev>';
  }

  private get webAppUrl(): string {
    return (process.env.WEB_APP_URL || 'https://chat-bullq-web.onrender.com').replace(
      /\/$/,
      '',
    );
  }

  isEnabled(): boolean {
    return !!this.apiKey;
  }

  /** Envia um e-mail. Best-effort: NUNCA lança — loga e devolve false em falha. */
  async send(input: SendEmailInput): Promise<boolean> {
    if (!this.apiKey) {
      this.logger.warn(
        `RESEND_API_KEY ausente — e-mail p/ ${input.to} não enviado (subject="${input.subject}")`,
      );
      return false;
    }
    try {
      const { data } = await axios.post(
        RESEND_ENDPOINT,
        {
          from: this.from,
          to: Array.isArray(input.to) ? input.to : [input.to],
          subject: input.subject,
          html: input.html,
          ...(input.text ? { text: input.text } : {}),
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      this.logger.log(
        `E-mail enviado via Resend para ${input.to} (id=${data?.id ?? '-'})`,
      );
      return true;
    } catch (err: any) {
      const detail =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        err?.message;
      this.logger.error(`Falha ao enviar e-mail para ${input.to}: ${detail}`);
      return false;
    }
  }

  /** Convite para entrar numa empresa (org). Monta o link de registro. */
  async sendInvitation(input: {
    to: string;
    orgName: string;
    token: string;
    role: string;
    inviterName?: string;
  }): Promise<boolean> {
    const link = `${this.webAppUrl}/register?invite=${encodeURIComponent(input.token)}`;
    const quem = input.inviterName
      ? `${input.inviterName} convidou você`
      : 'Você foi convidado';
    const subject = `Convite para ${input.orgName} no ChatBullQ`;
    const html = this.baseLayout(
      `Convite para ${input.orgName}`,
      `
      <p style="margin:0 0 16px">${quem} para participar de
        <strong>${escapeHtml(input.orgName)}</strong> no ChatBullQ.</p>
      <p style="margin:0 0 24px;color:#52525b">Clique no botão abaixo para criar
        sua conta e entrar na equipe. O convite expira em 7 dias.</p>
      <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;
        text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">
        Aceitar convite
      </a>
      <p style="margin:24px 0 0;color:#a1a1aa;font-size:12px;word-break:break-all">
        Ou copie e cole este link no navegador:<br>${link}</p>
      `,
    );
    const text =
      `${quem} para participar de ${input.orgName} no ChatBullQ.\n` +
      `Acesse: ${link}\nO convite expira em 7 dias.`;
    return this.send({ to: input.to, subject, html, text });
  }

  private baseLayout(title: string, body: string): string {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <div style="max-width:520px;margin:0 auto;padding:32px 16px">
          <div style="background:#fff;border-radius:14px;padding:32px;border:1px solid #e4e4e7">
            <h1 style="margin:0 0 20px;font-size:18px;color:#18181b">${escapeHtml(title)}</h1>
            ${body}
          </div>
          <p style="text-align:center;color:#a1a1aa;font-size:12px;margin:20px 0 0">
            ChatBullQ · e-mail automático, não responda.</p>
        </div>
      </body></html>`;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
