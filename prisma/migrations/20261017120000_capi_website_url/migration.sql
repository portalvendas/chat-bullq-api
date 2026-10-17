-- URL padrão do site/LP para eventos CAPI "website" quando a LP não envia a URL.
ALTER TABLE "meta_capi_configs" ADD COLUMN "website_url" TEXT;
