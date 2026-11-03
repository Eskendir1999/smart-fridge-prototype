-- Reviewable private storage definition. Not a production migration.
-- Execute only in an isolated acceptance database until release review.
CREATE SCHEMA IF NOT EXISTS sf_pilot_private;
REVOKE ALL ON SCHEMA sf_pilot_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sf_pilot_private.pilots (
 pilot_id text PRIMARY KEY,
 grants jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(grants) = 'object'),
 state jsonb NOT NULL DEFAULT '{"events":[],"streams":{},"attempts":{},"sequences":{}}'::jsonb
);
REVOKE ALL ON sf_pilot_private.pilots FROM PUBLIC;
ALTER TABLE sf_pilot_private.pilots ENABLE ROW LEVEL SECURITY;
-- No client policies or grants. Backend role provisioning is a separate review.
-- Grant/consent updates must UPDATE this same pilot row, acquiring its row lock.
