-- Issue #26: let users submit as many bug reports as they like.
--
-- The in-app bug form sends one row per report to `bug_reports`, keyed only by
-- a stable per-install `contact_id` (see supabase/functions/license/index.ts →
-- bug()). The table was created with a UNIQUE constraint on `contact_id`, so a
-- user's SECOND report hit a duplicate-key error and the function returned
-- { ok: false }. The fix is simply to allow many rows per contact.
--
-- This is written defensively: it drops any UNIQUE constraint or stand-alone
-- UNIQUE index defined on exactly (contact_id), regardless of the name Postgres
-- generated, and is safe to run more than once.
--
-- Apply via the Supabase Management API against the license project
-- (ref yyiqwpcqpohzyrzwyxqk) — not the SQL editor — per the deployment runbook.

-- 1) Drop any UNIQUE constraint whose columns are exactly {contact_id}.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'bug_reports'
      and con.contype = 'u'
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(con.conkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = con.conrelid and att.attnum = k.attnum
      ) = array['contact_id']
  loop
    execute format('alter table public.bug_reports drop constraint %I', c.conname);
  end loop;
end $$;

-- 2) Drop any stand-alone UNIQUE index on exactly {contact_id} (in case the
--    uniqueness was added as an index rather than a table constraint).
do $$
declare
  i record;
begin
  for i in
    select idx_cls.relname as idxname
    from pg_index idx
    join pg_class rel on rel.oid = idx.indrelid
    join pg_class idx_cls on idx_cls.oid = idx.indexrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'bug_reports'
      and idx.indisunique
      and not idx.indisprimary
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(idx.indkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = idx.indrelid and att.attnum = k.attnum
      ) = array['contact_id']
  loop
    execute format('drop index public.%I', i.idxname);
  end loop;
end $$;
