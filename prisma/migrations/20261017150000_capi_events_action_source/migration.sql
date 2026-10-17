-- Formato em que cada Purchase/AddToCart foi enviado (website | business_messaging | system_generated).
ALTER TABLE "meta_capi_events" ADD COLUMN "action_source" TEXT;
