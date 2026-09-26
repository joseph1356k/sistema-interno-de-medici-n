-- Vistas de agregacion. Toda la resolucion "dato -> persona" ocurre aqui.

-- ---------------------------------------------------------------------------
-- Resolucion de identidad
-- ---------------------------------------------------------------------------

-- hostname -> persona (telemetria de herramientas)
create or replace view v_device_person as
select d.hostname,
       d.person_id,
       coalesce(p.display_name, '(equipo sin asignar: ' || d.hostname || ')') as display_name
from devices d
left join people p on p.id = d.person_id;

-- email de git -> persona (actividad de GitHub, incluso con cuenta compartida)
create or replace view v_git_email_person as
select lower(e.email) as email, p.id as person_id, p.display_name
from people p
cross join lateral unnest(p.git_emails) as e(email);

-- Resolucion unificada de eventos de git. Intenta dos caminos, en este orden:
--   1. email del autor de los commits  -> funciona con cuentas compartidas
--   2. login de la cuenta que dispara   -> funciona con cuentas propias
-- Un evento sin resolver queda con person_id null y aparece en
-- v_unmapped_git_activity, para que nadie desaparezca en silencio.
create or replace view v_git_events_resolved as
select g.*,
       coalesce(pe.person_id, pl.id)             as person_id,
       coalesce(pe.display_name, pl.display_name) as display_name
from git_events g
left join v_git_email_person pe on pe.email = lower(g.author_email)
left join people pl on lower(pl.github_login) = lower(g.actor_login);

-- ---------------------------------------------------------------------------
-- Uso de herramientas por persona y dia
-- ---------------------------------------------------------------------------

-- Tiempo activo de Claude Code. La metrica viene con temporalidad `delta`, asi
-- que sumar las muestras del dia da el total del dia.
--   type=user -> escribir y leer respuestas
--   type=cli  -> ejecucion de herramientas y respuestas del modelo
create or replace view v_claude_active_time as
select dp.person_id,
       dp.display_name,
       m.hostname,
       date_trunc('day', m.observed_at)::date                as day,
       sum(m.value) filter (where m.attrs->>'type' = 'user') as user_seconds,
       sum(m.value) filter (where m.attrs->>'type' = 'cli')  as cli_seconds,
       sum(m.value)                                          as total_seconds
from tool_metrics m
join v_device_person dp on dp.hostname = m.hostname
where m.tool = 'claude_code'
  and m.metric = 'claude_code.active_time.total'
group by 1, 2, 3, 4;

-- Codex no expone metrica de tiempo activo. Se ESTIMA sumando los huecos entre
-- eventos consecutivos de una misma conversacion, ignorando huecos largos
-- (la persona se fue a hacer otra cosa). Es una estimacion, no una medicion:
-- el panel debe etiquetarla como tal y no compararla de tu a tu con Claude.
create or replace view v_codex_estimated_time as
with ordered as (
  select hostname,
         session_id,
         occurred_at,
         occurred_at - lag(occurred_at)
           over (partition by hostname, session_id order by occurred_at) as gap
  from tool_events
  where tool = 'codex' and session_id is not null
)
select dp.person_id,
       dp.display_name,
       o.hostname,
       date_trunc('day', o.occurred_at)::date as day,
       -- Tope de 5 min por hueco: mas alla se asume inactividad.
       sum(extract(epoch from least(o.gap, interval '5 minutes')))::double precision
         as estimated_seconds,
       count(distinct o.session_id) as sessions
from ordered o
join v_device_person dp on dp.hostname = o.hostname
where o.gap is not null
group by 1, 2, 3, 4;

-- Coste y tokens por persona y dia (ambas herramientas).
-- Las cifras de coste son aproximaciones segun la documentacion de Anthropic.
create or replace view v_daily_cost as
select dp.person_id,
       dp.display_name,
       m.tool,
       date_trunc('day', m.observed_at)::date as day,
       sum(m.value) filter (where m.metric in
         ('claude_code.cost.usage', 'codex.turn.cost_microusd_as_usd')) as cost_usd,
       sum(m.value) filter (where m.metric in
         ('claude_code.token.usage', 'codex.turn.token_usage'))         as tokens
from tool_metrics m
join v_device_person dp on dp.hostname = m.hostname
group by 1, 2, 3, 4;

-- Tasa de aceptacion de ediciones sugeridas: senal de CALIDAD, necesaria para
-- que el tiempo de uso no se lea solo.
create or replace view v_edit_acceptance as
select dp.person_id,
       dp.display_name,
       date_trunc('day', m.observed_at)::date as day,
       sum(m.value) filter (where m.attrs->>'decision' = 'accept') as accepted,
       sum(m.value) filter (where m.attrs->>'decision' = 'reject') as rejected,
       case when sum(m.value) > 0
            then sum(m.value) filter (where m.attrs->>'decision' = 'accept')
                 / sum(m.value)
       end as accept_rate
from tool_metrics m
join v_device_person dp on dp.hostname = m.hostname
where m.metric = 'claude_code.code_edit_tool.decision'
group by 1, 2, 3;

-- ---------------------------------------------------------------------------
-- Ritmo de entrega
-- ---------------------------------------------------------------------------

-- Actividad de git por persona y dia.
create or replace view v_daily_git as
select g.person_id,
       g.display_name,
       date_trunc('day', g.occurred_at)::date             as day,
       count(*) filter (where g.kind in ('push','force_push')) as pushes,
       sum(g.commit_count) filter (where g.kind in ('push','force_push')) as commits,
       count(*) filter (where g.kind = 'pr_opened')        as prs_opened,
       count(*) filter (where g.kind = 'pr_merged')        as prs_merged,
       count(*) filter (where g.kind = 'review')           as reviews_given
from v_git_events_resolved g
where g.person_id is not null
group by 1, 2, 3;

-- Tiempo entre push y push consecutivos de la misma persona.
-- Se expone el intervalo crudo; el panel agrega con MEDIANA, porque el promedio
-- lo desplaza cualquier fin de semana o vacaciones.
create or replace view v_push_intervals as
select g.person_id,
       g.display_name,
       g.repo,
       g.occurred_at,
       extract(epoch from (
         g.occurred_at - lag(g.occurred_at)
           over (partition by g.person_id order by g.occurred_at)
       )) / 3600.0 as hours_since_previous_push
from v_git_events_resolved g
where g.kind in ('push', 'force_push') and g.person_id is not null;

-- Tiempo de ciclo de PR: apertura -> merge, y apertura -> primera revision.
-- La primera revision se calcula desde los propios eventos de review, en vez de
-- guardarse en la fila del merge (que llega antes o despues sin orden garantizado).
create or replace view v_pr_cycle_time as
with first_review as (
  select repo, pr_number, min(occurred_at) as first_review_at
  from git_events
  where kind = 'review' and pr_number is not null
  group by 1, 2
)
select g.person_id,
       g.display_name,
       g.repo,
       g.pr_number,
       g.pr_created_at,
       g.pr_merged_at,
       coalesce(g.first_review_at, fr.first_review_at) as first_review_at,
       g.additions,
       g.deletions,
       g.changed_files,
       extract(epoch from (g.pr_merged_at - g.pr_created_at)) / 3600.0
         as hours_open_to_merge,
       extract(epoch from (
         coalesce(g.first_review_at, fr.first_review_at) - g.pr_created_at
       )) / 3600.0 as hours_to_first_review
from v_git_events_resolved g
left join first_review fr on fr.repo = g.repo and fr.pr_number = g.pr_number
where g.kind = 'pr_merged';

-- ---------------------------------------------------------------------------
-- Salud del propio sistema
-- ---------------------------------------------------------------------------

-- Equipos que dejaron de reportar. En Codex la configuracion es cooperativa
-- (el usuario la puede sobrescribir en Windows), asi que hay que vigilarlo.
create or replace view v_device_health as
select d.hostname,
       dp.display_name,
       d.active,
       d.last_seen,
       extract(epoch from (now() - d.last_seen)) / 3600.0 as hours_since_last_seen,
       exists (select 1 from tool_metrics m
               where m.hostname = d.hostname and m.tool = 'claude_code'
                 and m.observed_at > now() - interval '7 days') as claude_reporting,
       exists (select 1 from tool_events e
               where e.hostname = d.hostname and e.tool = 'codex'
                 and e.occurred_at > now() - interval '7 days') as codex_reporting
from devices d
left join v_device_person dp on dp.hostname = d.hostname;

-- Actividad que no se pudo atribuir a nadie: detecta a quien no configuro
-- `git config user.email`, o una cuenta de GitHub sin registrar en `people`.
create or replace view v_unmapped_git_activity as
select coalesce(lower(g.author_email), 'login:' || g.actor_login) as identity,
       count(*)           as events,
       min(g.occurred_at) as first_seen,
       max(g.occurred_at) as last_seen
from v_git_events_resolved g
where g.person_id is null
group by 1
order by 2 desc;
