CREATE INDEX "idx_conversations_clinician_recent" ON "conversations" USING btree ("clinician_id","updated_at","id");
