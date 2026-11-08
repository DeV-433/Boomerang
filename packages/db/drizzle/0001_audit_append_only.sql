-- Step 1.6: audit_log is append-only.
--
-- Two layers of enforcement:
--   1. A trigger rejects UPDATE, DELETE and TRUNCATE for every role, including the table owner.
--      This holds even where we cannot create roles (for example, a managed Postgres user without CREATEROLE).
--   2. An application role, boomerang_app, which has INSERT and SELECT on audit_log but no UPDATE,
--      DELETE or TRUNCATE. It is created only if the migrating user is allowed to create roles.

CREATE OR REPLACE FUNCTION audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boomerang_app') THEN
    BEGIN
      CREATE ROLE boomerang_app NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Cannot create role boomerang_app here; relying on the append-only trigger.';
      RETURN;
    END;
  END IF;

  BEGIN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO boomerang_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO boomerang_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO boomerang_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM boomerang_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO boomerang_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO boomerang_app';
    -- Let the migrating user switch into the role, so tests and the app can SET ROLE boomerang_app.
    EXECUTE format('GRANT boomerang_app TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Cannot grant on boomerang_app here; relying on the append-only trigger.';
  END;
END;
$$;
