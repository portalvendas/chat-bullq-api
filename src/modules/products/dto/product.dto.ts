import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export class CreateProductDto {
  @IsString()
  @Length(1, 60)
  @Matches(SLUG_RE, {
    message:
      'slug deve ser lowercase alfanumérico com hífens (ex: maestria, plantao-mensal)',
  })
  slug!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsString()
  @Length(1, 200)
  shortLine!: string;

  @IsString()
  @Length(1, 5000)
  pitch!: string;

  @IsOptional()
  @IsString()
  price?: string;

  @IsOptional()
  @IsString()
  paymentLink?: string;

  @IsOptional()
  @IsString()
  targetAudience?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  differentiators?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  @Matches(SLUG_RE)
  slug?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  shortLine?: string;

  @IsOptional()
  @IsString()
  @Length(1, 5000)
  pitch?: string;

  @IsOptional()
  @IsString()
  price?: string;

  @IsOptional()
  @IsString()
  paymentLink?: string;

  @IsOptional()
  @IsString()
  targetAudience?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  differentiators?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class ReorderProductsDto {
  @IsArray()
  @IsString({ each: true })
  ids!: string[];
}
