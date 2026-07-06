import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import {
  CreateProductDto,
  ReorderProductsDto,
  UpdateProductDto,
} from './dto/product.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';

@ApiTags('Products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List products for current org' })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.service.list(orgId, includeInactive === 'true');
  }

  @Get('by-slug/:slug')
  @ApiOperation({ summary: 'Fetch one product by slug — used by getProductPitch skill' })
  findBySlug(
    @CurrentOrg('id') orgId: string,
    @Param('slug') slug: string,
  ) {
    return this.service.findBySlug(orgId, slug);
  }

  @Post()
  @ApiOperation({ summary: 'Create product' })
  create(
    @CurrentOrg('id') orgId: string,
    @Body() dto: CreateProductDto,
  ) {
    return this.service.create(orgId, dto);
  }

  @Patch('reorder')
  @ApiOperation({ summary: 'Reorder products via drag-drop' })
  reorder(
    @CurrentOrg('id') orgId: string,
    @Body() dto: ReorderProductsDto,
  ) {
    return this.service.reorder(orgId, dto.ids);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update product' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete product' })
  remove(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.remove(id, orgId);
  }
}
