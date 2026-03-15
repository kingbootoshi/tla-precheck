CREATE UNIQUE INDEX "agent_runs_one_active_per_user" ON "public"."agent_runs" ("owner") WHERE "status" IN ('queued', 'running');

COMMENT ON INDEX "public"."agent_runs_one_active_per_user" IS 'tla-precheck:postgres:v1:b8007c6ccf6f8e52d85d65e10bef44d8c9f50d7385d7d6a89bf3c32d23637cf4';

ALTER TABLE "public"."agent_runs" ADD CONSTRAINT "agent_runs_active_requires_owner" CHECK ((NOT ("status" IN ('queued', 'running'))) OR ("owner" IS NOT NULL));

COMMENT ON CONSTRAINT "agent_runs_active_requires_owner" ON "public"."agent_runs" IS 'tla-precheck:postgres:v1:3f2638179272beede493b35c161a0ede19c355c1c8c305d616538a38e11d255f';
