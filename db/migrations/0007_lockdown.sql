-- Cierra el acceso publico a los datos de medicion.
--
-- Por defecto, Supabase expone via PostgREST cualquier tabla del esquema public a
-- quien tenga la clave anonima, que es publica por diseno. Estos datos no son
-- publicos: incluyen actividad por persona.
--
-- Dos barreras, porque una sola no basta:
--
--  1. RLS activado sin ninguna politica: anon y authenticated no ven ninguna fila.
--     `service_role` salta RLS, y es la unica clave que usa el panel (solo en
--     servidor, nunca en el navegador).
--  2. REVOKE sobre tablas Y VISTAS. Hace falta porque una vista creada por el
--     propietario del esquema NO aplica el RLS de sus tablas subyacentes: sin este
--     revoke, las vistas `v_*` filtrarian exactamente lo que las tablas protegen.
--     Es el fallo clasico de este montaje.
--
-- Los revokes se saltan si los roles de Supabase no existen, para que el esquema
-- se pueda aplicar tambien en un Postgres normal (db/verify.sh).

do $$
declare
  r record;
  supabase_roles boolean;
begin
  select exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated')
    into supabase_roles;

  -- RLS en todas las tablas base, sin ninguna politica.
  for r in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('alter table public.%I force row level security', r.tablename);
  end loop;

  if not supabase_roles then
    raise notice
      'Roles anon/authenticated no encontrados: se omiten los revokes (Postgres local).';
    return;
  end if;

  -- Revocar de los roles publicos todas las tablas y vistas.
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
  loop
    execute format('revoke all on public.%I from anon, authenticated', r.relname);
  end loop;

  -- Las funciones tampoco: solo el servidor las invoca.
  execute 'revoke all on function rollup_day(date) from anon, authenticated';
  execute 'revoke all on function apply_retention(integer) from anon, authenticated';

  -- Y que los objetos futuros nazcan cerrados, para que una migracion nueva no
  -- vuelva a abrir la puerta por descuido.
  execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
  execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';
end $$;
