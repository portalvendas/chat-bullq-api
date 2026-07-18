import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentOrg } from '../../../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../../../common/guards';
import { WhatsAppCoexistenceService } from './whatsapp-coexistence.service';

interface EmbeddedSignupDto {
  /** `code` retornado pelo Embedded Signup (response_type=code). */
  code: string;
  /** `waba_id` do evento FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING. */
  wabaId: string;
  /** Nome opcional pro canal. */
  name?: string;
}

/**
 * Recebe o resultado do Embedded Signup (Coexistence) do frontend e conclui o
 * onboarding no backend. O frontend só coleta { code, waba_id } do popup da
 * Meta e chama este endpoint (autenticado, escopo por org).
 */
@ApiTags('Integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('integrations/whatsapp/embedded-signup')
export class WhatsAppEmbeddedSignupController {
  constructor(private readonly coexistence: WhatsAppCoexistenceService) {}

  @Post()
  @ApiOperation({
    summary: 'Conclui o onboarding Coexistence (troca code, cria canal)',
  })
  async complete(
    @CurrentOrg('id') organizationId: string,
    @Body() dto: EmbeddedSignupDto,
  ): Promise<{
    channelId: string;
    phoneNumberId: string;
    displayPhoneNumber?: string;
  }> {
    return this.coexistence.onboard(
      organizationId,
      dto.code,
      dto.wabaId,
      dto.name,
    );
  }
}
