-- Phase 4: JSONB filtering lands now, so add the GIN index on Record.data that Phase 1 deferred.
-- jsonb_path_ops is the compact operator class for containment-style lookups on the data column.
-- The btree @@index([appId, entity, ownerId]) from the init migration already covers scope lookups.
CREATE INDEX IF NOT EXISTS "Record_data_gin_idx" ON "Record" USING GIN ("data" jsonb_path_ops);
