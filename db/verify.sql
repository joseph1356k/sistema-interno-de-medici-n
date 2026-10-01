-- Verificacion del esquema: aplica las migraciones sobre una base limpia, carga
-- fixtures y comprueba valores calculados a mano. Falla ruidosamente.
--
-- Uso:  ./db/verify.sh
--
-- Existe porque un error de logica en una vista de agregacion no se nota: produce
-- un numero plausible y equivocado. Estas aserciones son los numeros que se
-- comprobaron a mano una vez.

\set ON_ERROR_STOP on

do $$
declare
  v numeric;
  n integer;
begin
  -- Codex: huecos de 2, 3 y 35 min entre eventos. Con tope de 5 min por hueco,
  -- el tiempo estimado debe ser 2+3+5 = 10 min = 600 s, no 40 min.
  select round(estimated_seconds) into v from v_codex_estimated_time
   where hostname = 'pc-02' and day = '2026-09-20';
  assert v = 600, format('tiempo estimado de Codex: esperado 600 s, obtenido %s', v);

  -- Lead time de PR1: abierto 09-15 09:00, desplegado 09-16 12:00 = 27 h.
  select round(hours::numeric) into v from v_dora_lead_time where repo = 'e/app' and number = 1;
  assert v = 27, format('lead time PR1: esperado 27 h, obtenido %s', v);

  -- El basis debe decir que se midio hasta el despliegue, no hasta el merge.
  assert (select basis from v_dora_lead_time where repo = 'e/app' and number = 1) = 'to_deploy',
    'el lead time deberia medirse hasta el despliegue cuando hay despliegues';

  -- Ciclo desglosado de PR1: 5 h a revision, 19 h a aprobacion, 2 h a merge.
  select round(hours_to_first_review::numeric) into v from v_pr_cycle_breakdown where repo = 'e/app' and number = 1;
  assert v = 5, format('PR1 horas a primera revision: esperado 5, obtenido %s', v);
  select round(hours_approval_to_merge::numeric) into v from v_pr_cycle_breakdown where repo = 'e/app' and number = 1;
  assert v = 2, format('PR1 horas de aprobacion a merge: esperado 2, obtenido %s', v);

  -- Churn: de 3 archivos tocados, solo h_a se retoca dentro de 7 dias.
  select files_reworked into n from v_churn where repo = 'e/app';
  assert n = 1, format('archivos retrabajados: esperado 1, obtenido %s', n);

  -- Restauracion: main falla 09-25 08:04 y vuelve a verde 12:05 = 4 h.
  select round(hours::numeric) into v from v_dora_restore_time where repo = 'e/app' and branch = 'main';
  assert v = 4, format('tiempo de restauracion de main: esperado 4 h, obtenido %s', v);

  -- Tasa de fallo del cambio: 1 rollback de 3 despliegues.
  select round(failure_rate::numeric, 2) into v from v_dora_change_failure where repo = 'e/app';
  assert v = 0.33, format('tasa de fallo: esperado 0.33, obtenido %s', v);

  -- Carga de revision: Ana hizo 2 revisiones con 2 comentarios.
  select reviews into n from v_review_load where display_name = 'Ana' and week = '2026-09-14';
  assert n = 2, format('revisiones de Ana: esperado 2, obtenido %s', n);
  select comments into n from v_review_load where display_name = 'Ana' and week = '2026-09-14';
  assert n = 2, format('comentarios de Ana: esperado 2, obtenido %s', n);

  -- Aprobacion de sello: la de Luis no lleva comentarios.
  select without_comments into n from v_rubber_stamp where week = '2026-09-14';
  assert n = 1, format('aprobaciones sin comentarios: esperado 1, obtenido %s', n);

  -- Test inestable: sha3 falla DOS veces y pasa con el mismo commit.
  select count(*) into n from v_flaky_ci where repo = 'e/app';
  assert n = 1, format('tests inestables detectados: esperado 1, obtenido %s', n);
  assert (select head_sha from v_flaky_ci where repo = 'e/app') = 'sha3',
    'el commit marcado como inestable no es el esperado';

  -- Y el umbral importa: sha5 falla UNA vez y luego pasa, que es relanzar tras un
  -- corte de red. No debe aparecer, o la vista se llena de ruido.
  assert not exists (select 1 from v_flaky_ci where repo = 'e/app' and head_sha = 'sha5'),
    'un solo fallo seguido de exito no deberia contar como test inestable';

  -- Los PR grandes esperan mas a revision que los medianos. Es el hallazgo que
  -- justifica la vista; si se invierte, algo se rompio.
  assert (select median_hours_to_review from v_pr_size_buckets where bucket like '5.%')
       > (select median_hours_to_review from v_pr_size_buckets where bucket like '3.%'),
    'los PR XL deberian esperar mas a revision que los M';

  raise notice 'Vistas: todas las aserciones pasan';
end $$;

-- ---------------------------------------------------------------------------
-- Rollup
-- ---------------------------------------------------------------------------

do $$
declare n integer; v numeric;
begin
  perform rollup_day('2026-09-15');
  perform rollup_day('2026-09-16');
  perform rollup_day('2026-09-19');
  perform rollup_day('2026-09-20');

  -- Ana el 20: 1800 s de usuario + 900 s de cli = 2700 s.
  select round(claude_seconds) into v from daily_rollup r
    join people p on p.id = r.person_id
   where p.display_name = 'Ana' and r.day = '2026-09-20';
  assert v = 2700, format('segundos de Claude de Ana: esperado 2700, obtenido %s', v);

  -- Los PRs se cuentan desde pull_requests, no desde git_events (donde salia 0).
  select prs_merged into n from daily_rollup r
    join people p on p.id = r.person_id
   where p.display_name = 'Ana' and r.day = '2026-09-16';
  assert n = 1, format('PRs mergeados por Ana el 16: esperado 1, obtenido %s', n);

  -- Idempotencia: reejecutar no duplica.
  select count(*) into n from daily_rollup where day = '2026-09-20';
  perform rollup_day('2026-09-20');
  assert (select count(*) from daily_rollup where day = '2026-09-20') = n,
    'rollup_day duplico filas al reejecutarse';

  -- Un dia sin actividad no crea filas vacias.
  assert rollup_day('2026-01-01') = 0, 'un dia sin actividad no deberia crear filas';

  raise notice 'Rollup: todas las aserciones pasan';
end $$;

-- ---------------------------------------------------------------------------
-- Calidad de datos (0008)
-- ---------------------------------------------------------------------------

do $$
declare n integer; v numeric;
begin
  -- Codex desde el rollup acotado por fecha: debe dar lo mismo que la vista
  -- (2+3+5 min = 600 s), sin escanear todo el historico.
  perform rollup_day('2026-09-20');
  select round(codex_seconds_est) into v from daily_rollup r
    join people p on p.id = r.person_id
   where p.display_name = 'Luis' and r.day = '2026-09-20';
  assert v = 600, format('Codex desde el rollup: esperado 600 s, obtenido %s', v);

  -- Tokens sin lecturas de cache: 1000 + 500, no 901.500.
  perform rollup_day('2026-09-21');
  select tokens into n from daily_rollup r join people p on p.id = r.person_id
   where p.display_name = 'Ana' and r.day = '2026-09-21';
  assert n = 1500, format('tokens sin cacheRead: esperado 1500, obtenido %s', n);

  -- Solo despliegues a produccion y con exito: q1, q2 y el redespliegue de q1. Ni
  -- el preview ni el fallido.
  select deploys into n from v_dora_deploy_frequency where repo = 'e/q';
  assert n = 3, format('despliegues a produccion: esperado 3, obtenido %s', n);

  -- Fallos de cambio detectados: el fallido, la reversion por redespliegue y el PR
  -- de reversion.
  assert (select count(*) from v_change_failures where repo = 'e/q' and kind = 'deploy_failed') = 1,
    'no detecto el despliegue fallido';
  assert (select count(*) from v_change_failures where repo = 'e/q' and kind = 'rollback') = 1,
    'no detecto la reversion por redespliegue de un commit anterior';
  assert (select count(*) from v_change_failures where repo = 'e/q' and kind = 'revert_pr') = 1,
    'no detecto el PR de reversion';

  -- 3 fallos sobre 4 despliegues a produccion (el preview no cuenta).
  select round(failure_rate::numeric, 2) into v from v_dora_change_failure where repo = 'e/q';
  assert v = 0.75, format('tasa de fallo con deteccion real: esperado 0.75, obtenido %s', v);

  -- Los PR de bots no entran en el ciclo.
  assert not exists (select 1 from v_pr_cycle_breakdown where repo = 'e/q' and number = 501),
    'un PR de bot entro en las metricas de ciclo';

  -- Revisado durante el borrador: 0 horas, nunca negativo.
  select hours_to_first_review into v from v_pr_cycle_breakdown where repo = 'e/q' and number = 502;
  assert v = 0, format('horas a primera revision tras un borrador: esperado 0, obtenido %s', v);
  assert not exists (select 1 from v_pr_cycle_breakdown where hours_to_first_review < 0
                        or hours_review_to_approval < 0 or hours_approval_to_merge < 0),
    'quedan horas negativas en el ciclo desglosado';

  -- Mergeados sin revision: 503 y 504. El 502 tiene la de Ana (la autorrevision y
  -- la del bot no cuentan, pero la de Ana si).
  select merged_without_review into n from v_quality_signals where week = '2026-09-21';
  assert n = 2, format('mergeados sin revision: esperado 2, obtenido %s', n);

  -- Carga de revision: la autorrevision de Luis y la del bot no cuentan.
  assert not exists (select 1 from v_review_load where display_name = 'Luis' and week = '2026-09-21'),
    'una autorrevision conto como carga de revision';
  select reviews into n from v_review_load where display_name = 'Ana' and week = '2026-09-21';
  assert n = 1, format('revisiones de Ana esa semana: esperado 1, obtenido %s', n);
  assert not exists (select 1 from v_review_pairs where reviewer_login = 'coderabbit[bot]'),
    'un bot aparece en el reparto de revisiones';

  raise notice 'Calidad: dedup, produccion, fallos de cambio, bots y autorrevisiones correctos';
end $$;

-- Zona horaria: el mismo dato cae en un dia u otro segun la zona del equipo.
do $$
declare v numeric;
begin
  perform rollup_day('2026-09-21');
  perform rollup_day('2026-09-22');

  -- En UTC, 02:30 del 22 es el 22.
  select coalesce(sum(claude_seconds), 0) into v from daily_rollup r
    join people p on p.id = r.person_id where p.display_name = 'Zoe' and r.day = '2026-09-22';
  assert v = 600, format('UTC: esperado 600 s el 22, obtenido %s', v);

  -- En Bogota (UTC-5), es el 21 a las 21:30.
  perform set_team_timezone('America/Bogota');
  select coalesce(sum(claude_seconds), 0) into v from daily_rollup r
    join people p on p.id = r.person_id where p.display_name = 'Zoe' and r.day = '2026-09-21';
  assert v = 600, format('Bogota: esperado 600 s el 21, obtenido %s', v);
  select coalesce(sum(claude_seconds), 0) into v from daily_rollup r
    join people p on p.id = r.person_id where p.display_name = 'Zoe' and r.day = '2026-09-22';
  assert v = 0, format('Bogota: el 22 deberia estar vacio para Zoe, tiene %s', v);

  -- Un nombre de zona mal escrito no debe aceptarse: romperia todo el panel.
  begin
    perform set_team_timezone('America/Bogot');
    raise exception 'acepto una zona horaria inexistente';
  exception when others then
    if sqlerrm like 'acepto%' then raise; end if;
  end;

  perform set_team_timezone('UTC');
  raise notice 'Zona horaria: los dias se cortan en la hora local del equipo';
end $$;

-- Telemetria idempotente: el mismo punto dos veces se guarda una.
do $$
declare n integer;
begin
  insert into tool_metrics (dedup_key, hostname, tool, metric, value, observed_at)
  values ('k-dup', 'pc-01', 'claude_code', 'claude_code.session.count', 1, '2026-09-20T10:00:00Z')
  on conflict (dedup_key) do nothing;
  insert into tool_metrics (dedup_key, hostname, tool, metric, value, observed_at)
  values ('k-dup', 'pc-01', 'claude_code', 'claude_code.session.count', 1, '2026-09-20T10:00:00Z')
  on conflict (dedup_key) do nothing;

  select count(*) into n from tool_metrics where dedup_key = 'k-dup';
  assert n = 1, format('un reintento se guardo dos veces: %s filas', n);
  delete from tool_metrics where dedup_key = 'k-dup';

  raise notice 'Idempotencia: un reintento del collector no duplica';
end $$;

-- ---------------------------------------------------------------------------
-- Retencion: la promesa de PRIVACY.md
-- ---------------------------------------------------------------------------

do $$
declare n integer;
begin
  insert into tool_metrics (hostname, tool, metric, value, observed_at)
  values ('pc-01', 'claude_code', 'claude_code.active_time.total', 300,
          now() - interval '200 days');

  perform apply_retention(90);

  -- El detalle viejo se va...
  select count(*) into n from tool_metrics
   where observed_at < now() - interval '90 days';
  assert n = 0, format('quedo detalle mas viejo de 90 dias: %s filas', n);

  -- ...pero el agregado de ese dia se queda.
  select count(*) into n from daily_rollup
   where day = (now() - interval '200 days')::date;
  assert n = 1, 'la retencion borro el detalle sin conservar el agregado';

  -- Y recalcular despues ese dia NO debe borrar el agregado, que es lo unico que
  -- queda de el. Antes rollup_day lo vaciaba sin avisar.
  perform rollup_day((now() - interval '200 days')::date);
  select count(*) into n from daily_rollup
   where day = (now() - interval '200 days')::date;
  assert n = 1, 'recalcular un dia purgado borro su agregado';

  raise notice 'Retencion: el detalle se borra y el agregado se conserva';
end $$;

-- ---------------------------------------------------------------------------
-- Cierre de acceso publico
-- ---------------------------------------------------------------------------

do $$
declare
  n integer;
begin
  -- verify.sh crea los roles de Supabase, asi que el cierre se ejercita aqui igual
  -- que en el proyecto real.
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  assert n = 0, format('%s tablas sin RLS', n);

  -- La clave publica (anon) no puede leer ninguna tabla ni vista...
  select count(*) into n
  from pg_class c join pg_namespace s on s.oid = c.relnamespace
  where s.nspname = 'public' and c.relkind in ('r', 'v', 'm')
    and (has_table_privilege('anon', c.oid, 'select')
         or has_table_privilege('authenticated', c.oid, 'select'));
  assert n = 0, format('%s tablas o vistas legibles con la clave publica', n);

  -- ...ni ejecutar ninguna funcion. Antes podia, heredandolo de PUBLIC.
  select count(*) into n
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public'
    and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute'));
  assert n = 0, format('%s funciones ejecutables con la clave publica', n);

  -- El servidor, en cambio, tiene que poder con todo: si no, panel e ingesta caen.
  assert has_table_privilege('service_role', 'pull_requests', 'select,insert,update'),
    'service_role no puede escribir pull_requests';
  assert has_table_privilege('service_role', 'login_attempts', 'insert'),
    'service_role no puede apuntar intentos de acceso';
  assert has_sequence_privilege('service_role', 'login_attempts_id_seq', 'usage'),
    'service_role no puede usar la secuencia de login_attempts';
  assert has_table_privilege('service_role', 'v_quality_signals', 'select'),
    'service_role no puede leer las vistas';
  assert has_function_privilege('service_role', 'rollup_today()', 'execute'),
    'service_role no puede recalcular el dia';
  assert has_function_privilege('service_role', 'clear_demo_data()', 'execute'),
    'service_role no puede borrar la demo';

  -- Todas nuestras funciones fijan su search_path (aviso de seguridad de
  -- Supabase). Las de extensiones no cuentan: en local pgcrypto se instala en
  -- public, pero en Supabase vive en su propio esquema y no es nuestra.
  select count(*) into n
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false);
  assert n = 0, format('%s funciones sin search_path fijo', n);

  raise notice 'Cierre: la clave publica no lee ni ejecuta nada; el servidor, todo';
end $$;

-- ---------------------------------------------------------------------------
-- Tablero en vivo y borrado de la demo
-- ---------------------------------------------------------------------------

do $$
declare
  antes_reales integer;
  despues_reales integer;
  n integer;
  r jsonb;
begin
  -- El tablero arranca sin nada pendiente.
  select count(*) into n from live_snapshot where dirty_since is not null;
  assert n = 0, 'el tablero no deberia arrancar marcado como pendiente';

  select (select count(*) from pull_requests) + (select count(*) from git_events)
       + (select count(*) from people) + (select count(*) from tool_metrics)
    into antes_reales;

  -- Una muestra con las marcas de la semilla demo.
  insert into people (id, display_name, github_login)
  values ('dddddddd-0000-0000-0000-000000000001', 'Demo Uno', 'demo-uno');
  insert into devices (hostname, person_id)
  values ('demo-pc-1', 'dddddddd-0000-0000-0000-000000000001');
  insert into pull_requests (repo, number, state, event_ts)
  values ('demo/api', 1, 'merged', now());
  insert into git_events (dedup_key, kind, repo, occurred_at, meta)
  values ('demo:push:1', 'push', 'demo/api', now(), '{"source": "demo"}');
  insert into tool_metrics (hostname, tool, metric, value, observed_at)
  values ('demo-pc-1', 'claude_code', 'claude_code.active_time.total', 60, now());
  insert into daily_rollup (person_id, day)
  values ('dddddddd-0000-0000-0000-000000000001', current_date);

  r := clear_demo_data();
  assert (r->>'people')::int = 1, format('esperaba borrar 1 persona demo: %s', r);
  assert (r->>'pull_requests')::int = 1, format('esperaba borrar 1 PR demo: %s', r);

  select count(*) into n from people where id::text like 'dddddddd%';
  assert n = 0, 'quedaron personas demo';
  select count(*) into n from devices where hostname like 'demo-pc-%';
  assert n = 0, 'quedaron equipos demo';
  select count(*) into n from daily_rollup where person_id::text like 'dddddddd%';
  assert n = 0, 'quedo agregado de personas demo';

  -- Y lo real queda intacto.
  select (select count(*) from pull_requests) + (select count(*) from git_events)
       + (select count(*) from people) + (select count(*) from tool_metrics)
    into despues_reales;
  assert despues_reales = antes_reales,
    format('el borrado de la demo toco datos reales: %s -> %s', antes_reales, despues_reales);

  -- El tablero queda marcado para recalcularse sin la demo.
  select count(*) into n from live_snapshot where dirty_since is not null;
  assert n = 1, 'el borrado de la demo deberia marcar el tablero como pendiente';

  raise notice 'Demo: se borra solo lo marcado como demo, y el tablero se marca para recalcular';
end $$;
