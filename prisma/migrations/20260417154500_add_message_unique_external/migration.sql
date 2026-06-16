-- CreateIndex
CREATE UNIQUE INDEX "uq_msg_conv_external" ON "messages"("conversation_id", "external_id");
