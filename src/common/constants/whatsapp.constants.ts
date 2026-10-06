import { ChannelType } from '@prisma/client';

/**
 * Tipos de canal WhatsApp elegíveis para INICIAR conversa e TROCAR de canal
 * ("Enviar por"). Inclui o Oficial (Meta Cloud) e os "livres" que enviam texto
 * fora da janela de 24h: Z-API, Zappfy e o nativo Baileys (WhatsApp Business
 * via QR Code). Centralizado aqui pra não divergir entre os pontos de uso
 * (lista do seletor, start-whatsapp e validação do switch-channel).
 */
export const SWITCHABLE_WHATSAPP_TYPES: ChannelType[] = [
  ChannelType.WHATSAPP_OFFICIAL,
  ChannelType.WHATSAPP_ZAPPFY,
  ChannelType.WHATSAPP_ZAPI,
  ChannelType.WHATSAPP_BAILEYS,
];
