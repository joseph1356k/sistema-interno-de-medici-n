-- Datos de demostracion: 16 semanas de actividad inventada.
--
-- Sirven para poder leer el panel y para que las proyecciones tengan base antes de
-- conectar ningun equipo. Se identifican por prefijos conocidos (`demo/` en repos,
-- `demo-pc-` en equipos, UUIDs que empiezan por dddddddd), asi que db/seed/clear.sql
-- los borra sin ambiguedad y sin tocar datos reales.
--
-- Es SQL y no un script: asi se puede aplicar igual en un Postgres local y en el
-- proyecto real, sin necesitar la clave de servicio.
--
-- La variabilidad es intencionada: semanas buenas y malas, un PR por cada motivo
-- de bloqueo, CI roja en main con su restauracion, y un test inestable. Un panel
-- sembrado con datos perfectos no ensena como se ve un problema de verdad.

-- Pseudoaleatorio determinista a partir de un texto: el mismo script produce
-- siempre el mismo panel, asi que una captura de pantalla sigue siendo valida.
create or replace function demo_rand(seed text)
returns double precision language sql immutable as $$
  select (('x' || substr(md5(seed), 1, 4))::bit(16)::int) / 65535.0
$$;

-- Devuelve lo/hi interpolado por demo_rand.
create or replace function demo_between(seed text, lo double precision, hi double precision)
returns double precision language sql immutable as $$
  select lo + demo_rand(seed) * (hi - lo)
$$;

-- ---------------------------------------------------------------------------
-- Personas y equipos
-- ---------------------------------------------------------------------------

insert into people (id, display_name, git_emails, github_login, active) values
  ('dddddddd-0000-0000-0000-000000000001','Ana Ruiz',    array['demo-ana@demo.local'],   'demo-ana',   true),
  ('dddddddd-0000-0000-0000-000000000002','Luis Ortega', array['demo-luis@demo.local'],  'demo-luis',  true),
  ('dddddddd-0000-0000-0000-000000000003','Marta Vidal', array['demo-marta@demo.local'], 'demo-marta', true),
  ('dddddddd-0000-0000-0000-000000000004','Diego Sanz',  array['demo-diego@demo.local'], 'demo-diego', true)
on conflict (id) do nothing;

insert into devices (hostname, person_id, os, notes, last_seen)
select 'demo-pc-0' || n,
       ('dddddddd-0000-0000-0000-00000000000' || n)::uuid,
       'Windows 11',
       'equipo de demostración',
       now() - interval '20 minutes'
from generate_series(1, 4) n
on conflict (hostname) do nothing;

-- Tabla auxiliar con las personas y su nivel de uso, para no repetirla.
drop table if exists demo_tmp_people;
create table demo_tmp_people (n int, id uuid, login text, base double precision);
insert into demo_tmp_people values
  (1, 'dddddddd-0000-0000-0000-000000000001', 'demo-ana',   3.2),
  (2, 'dddddddd-0000-0000-0000-000000000002', 'demo-luis',  2.1),
  (3, 'dddddddd-0000-0000-0000-000000000003', 'demo-marta', 4.0),
  (4, 'dddddddd-0000-0000-0000-000000000004', 'demo-diego', 1.2);

-- Dias laborables de las ultimas 16 semanas, con alguna jornada suelta en fin de
-- semana para que el patron no salga artificialmente limpio.
drop table if exists demo_tmp_days;
create table demo_tmp_days as
select d,
       (current_date - d)::timestamptz + interval '11 hours' as at
from generate_series(0, 111) d
where extract(isodow from current_date - d) <= 5
   or demo_rand('we' || d) < 0.08;

-- ---------------------------------------------------------------------------
-- Telemetria de Claude Code
-- ---------------------------------------------------------------------------

drop table if exists demo_tmp_usage;
create table demo_tmp_usage as
select p.n, p.id as person_id, p.login, d.d, d.at,
       greatest(0.2, p.base * demo_between('h' || d.d || p.n, 0.4, 1.5)) as hours
from demo_tmp_days d
cross join demo_tmp_people p
-- Un dia de cada ocho sin actividad: reuniones, diseno, u otra clase de trabajo.
where demo_rand('skip' || d.d || p.n) > 0.12;

insert into tool_metrics (hostname, tool, service_name, metric, value, unit, attrs, observed_at)
select 'demo-pc-0' || n, 'claude_code', 'claude-code', m.metric, m.value, m.unit, m.attrs, at
from demo_tmp_usage u
cross join lateral (values
  ('claude_code.active_time.total', round(u.hours * 3600 * 0.62), 's', '{"type":"user"}'::jsonb),
  ('claude_code.active_time.total', round(u.hours * 3600 * 0.38), 's', '{"type":"cli"}'::jsonb),
  ('claude_code.cost.usage', round((u.hours * demo_between('c' || u.d || u.n, 0.9, 2.2))::numeric, 4), 'USD', '{}'::jsonb),
  ('claude_code.token.usage', round(u.hours * demo_between('t' || u.d || u.n, 28000, 65000)), '', '{"model":"claude-opus-5-5"}'::jsonb),
  ('claude_code.code_edit_tool.decision', round(demo_between('ea' || u.d || u.n, 4, 16)), '', '{"decision":"accept","tool_name":"Edit"}'::jsonb),
  ('claude_code.code_edit_tool.decision', round(demo_between('er' || u.d || u.n, 0, 5)), '', '{"decision":"reject","tool_name":"Edit"}'::jsonb),
  ('claude_code.lines_of_code.count', round(u.hours * demo_between('la' || u.d || u.n, 30, 110)), '', '{"type":"added"}'::jsonb),
  ('claude_code.lines_of_code.count', round(u.hours * demo_between('lr' || u.d || u.n, 10, 50)), '', '{"type":"removed"}'::jsonb)
) as m(metric, value, unit, attrs);

-- ---------------------------------------------------------------------------
-- Codex: solo dos de las cuatro personas, para que la vista de adopcion tenga
-- algo que ensenar.
-- ---------------------------------------------------------------------------

insert into tool_events (hostname, tool, service_name, event_name, session_id, attrs, occurred_at)
select 'demo-pc-0' || u.n,
       'codex',
       'codex',
       case when turn = 0 then 'codex.conversation_starts' else 'codex.api_request' end,
       'demo-conv-' || u.d || '-' || u.n,
       '{"model":"gpt-5-codex"}'::jsonb,
       u.at + interval '1 hour'
         + (turn * demo_between('g' || u.d || u.n || turn, 45, 240)) * interval '1 second'
from demo_tmp_usage u
cross join generate_series(0, 7) turn
where u.n <= 2
  and demo_rand('cx' || u.d || u.n) < 0.55
  and turn <= round(demo_between('ct' || u.d || u.n, 3, 8));

-- ---------------------------------------------------------------------------
-- Push
-- ---------------------------------------------------------------------------

insert into git_events (dedup_key, kind, repo, actor_login, author_email, ref, commit_count, occurred_at, meta)
select 'demo:push:' || u.d || ':' || u.n || ':' || k,
       'push',
       case when demo_rand('r' || u.d || u.n || k) < 0.5 then 'demo/api' else 'demo/web' end,
       'demo-cuenta-compartida',
       u.login || '@demo.local',
       'refs/heads/main',
       round(demo_between('cc' || u.d || u.n || k, 1, 5)),
       u.at + (demo_between('ph' || u.d || u.n || k, 1, 8)) * interval '1 hour',
       '{"source":"demo"}'::jsonb
from demo_tmp_usage u
cross join generate_series(0, 2) k
where k <= round(demo_between('np' || u.d || u.n, 0, 2.6))
on conflict (dedup_key) do nothing;

-- ---------------------------------------------------------------------------
-- Pull requests mergeados
-- ---------------------------------------------------------------------------

drop table if exists demo_tmp_prs;
create table demo_tmp_prs as
select
  100 + row_number() over (order by d.d desc, k) as number,
  case when demo_rand('pr' || d.d || k) < 0.5 then 'demo/api' else 'demo/web' end as repo,
  (select login from demo_tmp_people where n = 1 + floor(demo_rand('au' || d.d || k) * 4)::int) as author,
  (select login from demo_tmp_people where n = 1 + ((1 + floor(demo_rand('au' || d.d || k) * 4)::int) % 4)) as reviewer,
  (current_date - d.d)::timestamptz + interval '9 hours'
    + (demo_between('oh' || d.d || k, 0, 8)) * interval '1 hour' as opened,
  -- Los PR grandes son minoria, y tardan mas en revisarse. La relacion es real y
  -- el panel la muestra, asi que los datos de demostracion deben tenerla.
  case when demo_rand('sz' || d.d || k) < 0.2
       then demo_between('szb' || d.d || k, 400, 1400)
       else demo_between('szs' || d.d || k, 15, 250)
  end as size,
  demo_rand('ch' || d.d || k) < 0.3 as changes_first,
  -- La mayoria de los PR pasan CI a la primera. Los reintentos sobre el MISMO
  -- commit son minoria, porque lo normal es empujar un arreglo (sha nuevo).
  case when demo_rand('att' || d.d || k) < 0.20
       then 2 + (case when demo_rand('att2' || d.d || k) < 0.3 then 1 else 0 end)
       else 1 end as ci_attempts
from generate_series(3, 111) d(d)
cross join generate_series(0, 2) k
where extract(isodow from current_date - d.d) <= 5
  -- Una semana de cada cuatro es floja: es lo que hace util el Monte Carlo.
  and demo_rand('skipd' || d.d) > 0.25
  and k <= round(demo_between('npd' || d.d, 0, 2.4));

drop table if exists demo_tmp_pr_times;
create table demo_tmp_pr_times as
select p.*,
       case when p.size > 350
            then demo_between('sf' || p.number, 2.5, 5)
            else demo_between('sf' || p.number, 0.6, 1.6) end as size_factor
from demo_tmp_prs p;

drop table if exists demo_tmp_pr_full;
create table demo_tmp_pr_full as
select t.*,
       t.opened + (demo_between('tr' || t.number, 1.5, 14) * t.size_factor) * interval '1 hour' as first_review,
       t.opened + (demo_between('tr' || t.number, 1.5, 14) * t.size_factor) * interval '1 hour'
                + demo_between('ta' || t.number, 0.5, 8) * interval '1 hour' as approved,
       t.opened + (demo_between('tr' || t.number, 1.5, 14) * t.size_factor) * interval '1 hour'
                + demo_between('ta' || t.number, 0.5, 8) * interval '1 hour'
                + demo_between('tm' || t.number, 0.2, 5) * interval '1 hour' as merged
from demo_tmp_pr_times t;

insert into pull_requests (
  repo, number, author_login, state, draft, head_sha, base_ref,
  additions, deletions, changed_files, commits, mergeable, mergeable_state,
  requested_reviewers, last_review_state,
  created_at, ready_at, first_review_at, approved_at, merged_at, event_ts)
select repo, number, author, 'merged', false, 'demosha' || number, 'main',
       round(size * 0.7), round(size * 0.3),
       greatest(1, round(size / 60)), greatest(1, round(size / 90)),
       true, 'clean', 0, 'approved',
       opened, opened, first_review, approved, merged, merged
from demo_tmp_pr_full
on conflict (repo, number) do nothing;

insert into reviews (dedup_key, repo, pr_number, reviewer_login, pr_author_login, state, submitted_at, external_id)
select 'demo:rv:' || number || ':1', repo, number, reviewer, author,
       'changes_requested', first_review, 'demo-rev-' || number || '-1'
from demo_tmp_pr_full where changes_first
on conflict (dedup_key) do nothing;

insert into reviews (dedup_key, repo, pr_number, reviewer_login, pr_author_login, state, submitted_at, external_id)
select 'demo:rv:' || number || ':2', repo, number, reviewer, author,
       'approved', approved, 'demo-rev-' || number || '-2'
from demo_tmp_pr_full
on conflict (dedup_key) do nothing;

insert into review_comments (dedup_key, repo, pr_number, review_id, commenter_login, created_at)
select 'demo:rc:' || f.number || ':' || c, f.repo, f.number,
       'demo-rev-' || f.number || '-1', f.reviewer,
       f.first_review + c * interval '1 minute'
from demo_tmp_pr_full f
cross join generate_series(0, 4) c
where f.changes_first and c <= round(demo_between('nc' || f.number, 1, 4.4))
on conflict (dedup_key) do nothing;

-- CI de cada PR: reintentos ocasionales, verde en el ultimo intento.
insert into ci_runs (dedup_key, repo, head_sha, provider, external_id, name, branch,
                     status, conclusion, attempt, trigger_event,
                     started_at, completed_at, duration_seconds)
select 'demo:ci:' || f.number || ':' || a,
       f.repo, 'demosha' || f.number, 'workflow_run',
       'demo-run-' || f.number || '-' || a, 'CI', 'feature/demo-' || f.number,
       'completed',
       case when a = f.ci_attempts then 'success' else 'failure' end,
       a, 'pull_request',
       f.opened + a * interval '30 minutes',
       f.opened + a * interval '30 minutes' + demo_between('cd' || f.number || a, 180, 900) * interval '1 second',
       round(demo_between('cd' || f.number || a, 180, 900))
from demo_tmp_pr_full f
cross join generate_series(1, 4) a
where a <= f.ci_attempts
on conflict (dedup_key) do nothing;

-- Archivos tocados, ya en forma de hash: es como los guarda el sistema real.
insert into commit_files (dedup_key, repo, sha, path_hash, change_type, committed_at)
select 'demo:cf:' || f.number || ':' || ph, f.repo, 'demosha' || f.number,
       'demo-hash-' || ph,
       case when demo_rand('ct' || f.number || ph) < 0.25 then 'added' else 'modified' end,
       f.merged
from demo_tmp_pr_full f
cross join lateral (
  select (floor(demo_rand('fp' || f.number || i) * 40))::int as ph
  from generate_series(0, 11) i
  where i <= greatest(1, round(f.size / 120))
) files
on conflict (dedup_key) do nothing;

-- ---------------------------------------------------------------------------
-- PRs abiertos ahora: uno por motivo de bloqueo, para que el tablero en vivo
-- tenga las seis columnas con contenido.
-- ---------------------------------------------------------------------------

insert into pull_requests (
  repo, number, author_login, state, draft, head_sha, base_ref,
  additions, deletions, changed_files, commits, mergeable, mergeable_state,
  requested_reviewers, last_review_state,
  created_at, ready_at, first_review_at, approved_at, event_ts)
values
  ('demo/api', 9001, 'demo-ana',   'open', false, 'demoopen1', 'main', 140, 40, 4, 3, true,  'clean',    1, null,
   now() - interval '5 days', now() - interval '5 days', null, null, now() - interval '5 days'),
  ('demo/web', 9002, 'demo-luis',  'open', false, 'demoopen2', 'main',  60, 10, 2, 1, true,  'clean',    0, null,
   now() - interval '3 days', now() - interval '3 days', null, null, now() - interval '3 days'),
  ('demo/api', 9003, 'demo-marta', 'open', false, 'demoopen3', 'main', 220, 80, 7, 4, true,  'clean',    1, 'changes_requested',
   now() - interval '2 days', now() - interval '2 days', now() - interval '1 day', null, now() - interval '2 days'),
  ('demo/web', 9004, 'demo-diego', 'open', false, 'demoopen4', 'main',  90, 30, 3, 2, false, 'dirty',    1, null,
   now() - interval '4 days', now() - interval '4 days', null, null, now() - interval '4 days'),
  ('demo/api', 9005, 'demo-ana',   'open', false, 'demoopen5', 'main', 300, 60, 9, 5, true,  'unstable', 1, null,
   now() - interval '1 day', now() - interval '1 day', null, null, now() - interval '1 day'),
  ('demo/web', 9006, 'demo-luis',  'open', false, 'demoopen6', 'main',  45, 15, 2, 1, true,  'clean',    0, 'approved',
   now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', now() - interval '1 day', now() - interval '2 days'),
  ('demo/api', 9007, 'demo-marta', 'open', true,  'demoopen7', 'main', 180, 20, 5, 3, true,  'draft',    0, null,
   now() - interval '6 days', null, null, null, now() - interval '6 days')
on conflict (repo, number) do nothing;

-- CI en rojo del PR 9005, que es lo que lo bloquea.
insert into ci_runs (dedup_key, repo, head_sha, provider, name, branch, status, conclusion,
                     attempt, trigger_event, started_at, completed_at, duration_seconds)
values ('demo:ci:open:9005', 'demo/api', 'demoopen5', 'workflow_run', 'CI',
        'feature/demo-9005', 'completed', 'failure', 1, 'pull_request',
        now() - interval '20 hours', now() - interval '19 hours', 400)
on conflict (dedup_key) do nothing;

-- ---------------------------------------------------------------------------
-- CI de la rama principal, con roturas y su restauracion
-- ---------------------------------------------------------------------------

insert into ci_runs (dedup_key, repo, head_sha, provider, name, branch, status, conclusion,
                     attempt, trigger_event, started_at, completed_at, duration_seconds)
select 'demo:ci:main:' || d,
       'demo/api', 'demomain' || d, 'workflow_run', 'CI', 'main', 'completed',
       case when demo_rand('mb' || d) < 0.07 then 'failure' else 'success' end,
       1, 'push',
       (current_date - d)::timestamptz + interval '8 hours',
       (current_date - d)::timestamptz + interval '8 hours' + demo_between('md' || d, 200, 700) * interval '1 second',
       round(demo_between('md' || d, 200, 700))
from generate_series(0, 111) d
where extract(isodow from current_date - d) <= 5
on conflict (dedup_key) do nothing;

insert into ci_runs (dedup_key, repo, head_sha, provider, name, branch, status, conclusion,
                     attempt, trigger_event, started_at, completed_at, duration_seconds)
select 'demo:ci:main:' || d || ':fix',
       'demo/api', 'demomain' || d || 'fix', 'workflow_run', 'CI', 'main', 'completed',
       'success', 1, 'push',
       (current_date - d)::timestamptz + interval '8 hours' + demo_between('mf' || d, 1.5, 7) * interval '1 hour',
       (current_date - d)::timestamptz + interval '8 hours' + demo_between('mf' || d, 1.5, 7) * interval '1 hour' + interval '400 seconds',
       400
from generate_series(0, 111) d
where extract(isodow from current_date - d) <= 5
  and demo_rand('mb' || d) < 0.07
on conflict (dedup_key) do nothing;

-- Un test inestable: mismo workflow, MISMO commit, resultados distintos.
insert into ci_runs (dedup_key, repo, head_sha, provider, name, branch, status, conclusion,
                     attempt, trigger_event, started_at, completed_at, duration_seconds)
select 'demo:ci:flaky:' || n,
       'demo/web', 'demoflaky001', 'workflow_run', 'Tests de integración', 'main',
       'completed',
       case when n % 2 = 0 then 'failure' else 'success' end,
       n + 1, 'push',
       now() - interval '4 days' + n * interval '1 hour',
       now() - interval '4 days' + n * interval '1 hour' + interval '300 seconds',
       300
from generate_series(0, 3) n
on conflict (dedup_key) do nothing;

-- ---------------------------------------------------------------------------
-- Despliegues semanales, con alguna reversion
-- ---------------------------------------------------------------------------

insert into deployments (dedup_key, repo, environment, ref, source, deployed_at, is_rollback)
select 'demo:dep:' || w, 'demo/api', 'production', 'v1.' || (16 - w) || '.0', 'release',
       (current_date - (w * 7 + 1))::timestamptz + interval '18 hours', false
from generate_series(0, 16) w
on conflict (dedup_key) do nothing;

insert into deployments (dedup_key, repo, environment, ref, source, deployed_at, is_rollback)
select 'demo:dep:' || w || ':rb', 'demo/api', 'production', 'v1.' || (16 - w) || '.1', 'release',
       (current_date - (w * 7 + 1))::timestamptz + interval '19 hours 30 minutes', true
from generate_series(0, 16) w
where demo_rand('rb' || w) < 0.15
on conflict (dedup_key) do nothing;

-- ---------------------------------------------------------------------------
-- Rollup de todos los dias sembrados
-- ---------------------------------------------------------------------------

select count(*) as dias_agregados
from generate_series(0, 111) d, lateral rollup_day((current_date - d)::date);

-- Limpieza de las tablas auxiliares.
drop table if exists demo_tmp_pr_full;
drop table if exists demo_tmp_pr_times;
drop table if exists demo_tmp_prs;
drop table if exists demo_tmp_usage;
drop table if exists demo_tmp_days;
drop table if exists demo_tmp_people;

select
  (select count(*) from people where id::text like 'dddddddd%')     as personas,
  (select count(*) from pull_requests where repo like 'demo/%')      as prs,
  (select count(*) from reviews where repo like 'demo/%')            as revisiones,
  (select count(*) from ci_runs where repo like 'demo/%')            as ejecuciones_ci,
  (select count(*) from tool_metrics where hostname like 'demo-pc-%') as metricas,
  (select count(*) from daily_rollup)                                as filas_rollup;
