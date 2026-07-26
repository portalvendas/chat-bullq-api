-- CreateTable
CREATE TABLE "cadences" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stop_on_reply" BOOLEAN NOT NULL DEFAULT true,
    "business_hours_only" BOOLEAN NOT NULL DEFAULT false,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "onEnd" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cadences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cadence_runs" (
    "id" TEXT NOT NULL,
    "cadence_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "stopped_reason" TEXT,

    CONSTRAINT "cadence_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_cadence_org_active" ON "cadences"("organization_id", "active");

-- CreateIndex
CREATE INDEX "idx_cadencerun_conv_status" ON "cadence_runs"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "idx_cadencerun_cadence_status" ON "cadence_runs"("cadence_id", "status");

-- AddForeignKey
ALTER TABLE "cadences" ADD CONSTRAINT "cadences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadence_runs" ADD CONSTRAINT "cadence_runs_cadence_id_fkey" FOREIGN KEY ("cadence_id") REFERENCES "cadences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
