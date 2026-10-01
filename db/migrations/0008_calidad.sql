-- Calidad de datos, zona horaria del equipo y endurecimiento.
--
-- Cada bloque corrige un numero que antes salia mal sin que nada lo delatara: el
-- tipo de error mas peligroso en un panel, porque se lee como un hallazgo.

-- ---------------------------------------------------------------------------
-- 1. Telemetria idempotente
-- ---------------------------------------------------------------------------

-- El collector reintenta un lote hasta 24 horas, y un reintento puede llegar
-- aunque el servidor ya lo hubiera guardado. Sin clave, cada reintento sumaba otra
-- vez el mismo tiempo activo y el mismo coste. La clave la calcula src/lib/otlp.ts.
alter table tool_metrics add column dedup_key text;
create unique index tool_metrics_dedup_key on tool_metrics (dedup_key);

alter table tool_events add column dedup_key text;
create unique index tool_events_dedup_key on tool_events (dedup_key);

-- ---------------------------------------------------------------------------
-- 2. Ajustes: zona horaria del equipo y retencion
-- ---------------------------------------------------------------------------

create table settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

comment on table settings is
  'Configuracion que necesita SQL. Cambiar team_timezone con set_team_timezone().';

insert into settings (key, value) values
  ('team_timezone', 'UTC'),
  ('retention_days', '90')
on conflict (key) do nothing;

/**
 * Zona horaria en la que se cortan los dias.
 *
 * Antes todo se cortaba en UTC. Para un equipo en UTC-5, el trabajo a partir de
 * las 19:00 caia en el dia siguiente, y la vista "Hoy" se quedaba casi vacia cada
 * tarde porque el dia UTC ya habia cambiado.
 */
create or replace function team_tz() returns text
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce((select value from settings where key = 'team_timezone'), 'UTC')
$$;

create or replace function team_today() returns date
language sql stable
set search_path = public, pg_temp
as $$
  select (now() at time zone team_tz())::date
$$;

/** Inicio de un dia local del equipo, como instante absoluto. */
create or replace function team_day_start(d date) returns timestamptz
language sql stable
set search_path = public, pg_temp
as $$
  select d::timestamp at time zone team_tz()
$$;

create or replace function retention_days() returns integer
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce((select value::integer from settings where key = 'retention_days'), 90)
$$;

/**
 * Cambia la zona horaria y recalcula los dias que aun tienen detalle, para que el
 * historico quede cortado igual que lo nuevo. Valida el nombre: una zona mal
 * escrita haria fallar todas las consultas del panel.
 */
create or replace function set_team_timezone(tz text) returns text
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = tz) then
    raise exception 'Zona horaria desconocida: %. Usa un nombre IANA, como America/Bogota o Europe/Madrid.', tz;
  end if;

  insert into settings (key, value, updated_at) values ('team_timezone', tz, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  perform rollup_recent(retention_days());
  return tz;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Bots, autorrevisiones y ramas de PR
-- ---------------------------------------------------------------------------

-- Rama de origen del PR. Hace falta para detectar reversiones: el boton "Revert"
-- de GitHub crea ramas `revert-<numero>-<rama>`. Es metadato visible en el
-- repositorio, como la rama de los push que ya se guardaba.
alter table pull_requests add column head_ref text;

-- Los PRs de dependabot y similares no son trabajo del equipo: inflaban el
-- throughput y distorsionaban el tiempo de ciclo (se mergean solos, o se quedan
-- abiertos semanas). Se marcan y se excluyen de las metricas.
alter table pull_requests add column is_bot boolean
  generated always as (coalesce(author_login, '') like '%[bot]') stored;

-- Una revision de un bot llega a los segundos y hacia que el "tiempo hasta la
-- primera revision" pareciera cero. Una autorrevision (el autor comentando su
-- propio PR) tambien. Ninguna de las dos es la revision que se esta esperando.
alter table reviews add column is_bot boolean
  generated always as (coalesce(reviewer_login, '') like '%[bot]') stored;
alter table reviews add column is_self boolean
  generated always as (lower(coalesce(reviewer_login, '')) = lower(coalesce(pr_author_login, '-'))) stored;

-- ---------------------------------------------------------------------------
-- 4. Despliegues: solo produccion, y fallos de verdad
-- ---------------------------------------------------------------------------

alter table deployments add column status text not null default 'success';

-- Con Vercel, cada preview genera un despliegue en GitHub: contarlos inflaba la
-- frecuencia de despliegue de forma absurda. DORA mide produccion. Vercel nombra
-- los entornos "Production – proyecto" y "Preview – proyecto".
alter table deployments add column is_production boolean
  generated always as (coalesce(environment, '') ~* '^prod') stored;

create index deployments_prod_idx
  on deployments (repo, deployed_at desc) where is_production;

-- ---------------------------------------------------------------------------
-- 5. Limite de intentos de acceso al panel
-- ---------------------------------------------------------------------------

-- Se guarda un HMAC de la IP, nunca la IP. Se borra a las 24 horas.
create table login_attempts (
  id           bigserial   primary key,
  ip_hash      text        not null,
  attempted_at timestamptz not null default now(),
  success      boolean     not null
);
create index login_attempts_ip_idx on login_attempts (ip_hash, attempted_at desc);

-- ---------------------------------------------------------------------------
-- 6. Rollup: dias locales, Codex acotado, tokens sin lecturas de cache
-- ---------------------------------------------------------------------------

create or replace function rollup_day(target date) returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  affected  integer;
  day_start timestamptz := team_day_start(target);
  day_end   timestamptz := team_day_start(target + 1);
begin
  -- Guarda contra la perdida de datos: si el detalle de ese dia ya se purgo por
  -- retencion, el agregado es lo unico que queda. Recalcularlo lo dejaria vacio.
  if day_start < now() - make_interval(days => retention_days())
     and not exists (select 1 from tool_metrics
                     where observed_at >= day_start and observed_at < day_end)
     and exists (select 1 from daily_rollup where day = target)
  then
    return 0;
  end if;

  delete from daily_rollup where day = target;

  insert into daily_rollup (
    person_id, day, claude_seconds, codex_seconds_est, sessions, tokens, cost_usd,
    edits_accepted, edits_rejected, lines_added, lines_removed,
    pushes, commits, prs_opened, prs_merged, reviews_given, review_comments
  )
  select
    p.id, target,
    coalesce(tm.claude_seconds, 0),
    coalesce(cx.codex_seconds, 0),
    coalesce(cx.sessions, 0),
    coalesce(tm.tokens, 0),
    coalesce(tm.cost_usd, 0),
    coalesce(tm.edits_accepted, 0),
    coalesce(tm.edits_rejected, 0),
    coalesce(tm.lines_added, 0),
    coalesce(tm.lines_removed, 0),
    coalesce(g.pushes, 0),
    coalesce(g.commits, 0),
    coalesce(pq.prs_opened, 0),
    coalesce(pq.prs_merged, 0),
    coalesce(rv.reviews_given, 0),
    coalesce(rv.review_comments, 0)
  from people p

  left join (
    select d.person_id,
           sum(m.value) filter (
             where m.metric = 'claude_code.active_time.total') as claude_seconds,
           -- Las lecturas de cache son enormes y casi gratis: sumarlas hacia que
           -- "tokens" midiera sobre todo cuanto contexto se reutiliza, no trabajo.
           sum(m.value) filter (
             where m.metric in ('claude_code.token.usage', 'codex.turn.token_usage')
               and coalesce(m.attrs->>'type', '') <> 'cacheRead') as tokens,
           sum(m.value) filter (
             where m.metric = 'claude_code.cost.usage') as cost_usd,
           sum(m.value) filter (
             where m.metric = 'claude_code.code_edit_tool.decision'
               and m.attrs->>'decision' = 'accept') as edits_accepted,
           sum(m.value) filter (
             where m.metric = 'claude_code.code_edit_tool.decision'
               and m.attrs->>'decision' = 'reject') as edits_rejected,
           sum(m.value) filter (
             where m.metric = 'claude_code.lines_of_code.count'
               and m.attrs->>'type' = 'added') as lines_added,
           sum(m.value) filter (
             where m.metric = 'claude_code.lines_of_code.count'
               and m.attrs->>'type' = 'removed') as lines_removed
    from tool_metrics m
    join devices d on d.hostname = m.hostname
    where m.observed_at >= day_start and m.observed_at < day_end
      and d.person_id is not null
    group by d.person_id
  ) tm on tm.person_id = p.id

  -- Tiempo estimado de Codex. Antes salia de una vista que calculaba los huecos
  -- sobre TODO el historico y filtraba despues; ahora se acota al dia (mas uno
  -- antes, para tener el evento previo de las sesiones que cruzan la medianoche).
  left join (
    with ev as (
      select d.person_id,
             e.session_id,
             e.occurred_at,
             e.occurred_at - lag(e.occurred_at)
               over (partition by e.hostname, e.session_id order by e.occurred_at) as gap
      from tool_events e
      join devices d on d.hostname = e.hostname
      where e.tool = 'codex'
        and e.session_id is not null
        and d.person_id is not null
        and e.occurred_at >= day_start - interval '1 day'
        and e.occurred_at < day_end
    )
    select person_id,
           sum(extract(epoch from least(gap, interval '5 minutes'))) as codex_seconds,
           count(distinct session_id) as sessions
    from ev
    where occurred_at >= day_start and gap is not null
    group by person_id
  ) cx on cx.person_id = p.id

  left join (
    select person_id,
           count(*)          as pushes,
           sum(commit_count) as commits
    from v_git_events_resolved
    where kind in ('push', 'force_push')
      and occurred_at >= day_start and occurred_at < day_end
      and person_id is not null
    group by person_id
  ) g on g.person_id = p.id

  left join (
    select pe.id as person_id,
           count(*) filter (
             where pr.created_at >= day_start and pr.created_at < day_end) as prs_opened,
           count(*) filter (
             where pr.merged_at >= day_start and pr.merged_at < day_end) as prs_merged
    from people pe
    join pull_requests pr on lower(pr.author_login) = lower(pe.github_login)
    where not pr.is_bot
    group by pe.id
  ) pq on pq.person_id = p.id

  left join (
    select pe.id as person_id,
           count(distinct r.id)  as reviews_given,
           count(distinct rc.id) as review_comments
    from people pe
    left join reviews r
      on lower(r.reviewer_login) = lower(pe.github_login)
     and r.submitted_at >= day_start and r.submitted_at < day_end
     and not r.is_self
    left join review_comments rc
      on lower(rc.commenter_login) = lower(pe.github_login)
     and rc.created_at >= day_start and rc.created_at < day_end
    group by pe.id
  ) rv on rv.person_id = p.id

  where p.active
    and (tm.person_id is not null or cx.person_id is not null
         or g.person_id is not null
         or coalesce(pq.prs_opened, 0) + coalesce(pq.prs_merged, 0) > 0
         or coalesce(rv.reviews_given, 0) > 0);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

/** El dia en curso, en la zona del equipo. Lo usa el tablero en vivo. */
create or replace function rollup_today() returns integer
language sql
set search_path = public, pg_temp
as $$
  select rollup_day(team_today())
$$;

/**
 * Los ultimos `days` dias. La logica de fechas vive aqui, en SQL, y no en el
 * servidor: asi solo hay un sitio que sabe en que zona horaria esta el equipo.
 */
create or replace function rollup_recent(days integer) returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  d     integer;
  total integer := 0;
begin
  for d in 0..days loop
    total := total + rollup_day(team_today() - d);
  end loop;
  return total;
end;
$$;

-- Retencion: lee el plazo de `settings`, y limpia tambien los intentos de acceso.
drop function if exists apply_retention(integer);
create function apply_retention(keep_days integer default null)
returns table (deleted_metrics bigint, deleted_events bigint, rolled_days integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  keep   integer := coalesce(keep_days, retention_days());
  cutoff timestamptz := now() - make_interval(days => keep);
  d      date;
  rolled integer := 0;
  dm     bigint;
  de     bigint;
begin
  -- Rellena el agregado de cada dia antiguo ANTES de borrar su detalle.
  for d in
    select distinct (observed_at at time zone team_tz())::date
    from tool_metrics
    where observed_at < cutoff
    order by 1
  loop
    perform rollup_day(d);
    rolled := rolled + 1;
  end loop;

  delete from tool_metrics where observed_at < cutoff;
  get diagnostics dm = row_count;

  delete from tool_events where occurred_at < cutoff;
  get diagnostics de = row_count;

  delete from login_attempts where attempted_at < now() - interval '1 day';

  return query select dm, de, rolled;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Vistas: hoy local, produccion, sin bots, sin horas negativas
-- ---------------------------------------------------------------------------

create or replace view v_today_activity as
select p.id                             as person_id,
       p.display_name,
       coalesce(r.claude_seconds, 0)    as claude_seconds,
       coalesce(r.codex_seconds_est, 0) as codex_seconds_est,
       coalesce(r.sessions, 0)          as sessions,
       coalesce(r.pushes, 0)            as pushes,
       coalesce(r.commits, 0)           as commits,
       coalesce(r.prs_opened, 0)        as prs_opened,
       coalesce(r.prs_merged, 0)        as prs_merged,
       coalesce(r.reviews_given, 0)     as reviews_given,
       coalesce(r.review_comments, 0)   as review_comments,
       coalesce(r.cost_usd, 0)          as cost_usd
from people p
left join daily_rollup r on r.person_id = p.id and r.day = team_today()
where p.active;

create or replace view v_trailing_average as
with por_dia as (
  select day,
         sum(claude_seconds + codex_seconds_est) / 3600.0 as tool_hours,
         sum(pushes)     as pushes,
         sum(prs_merged) as merges
  from daily_rollup
  where day >= team_today() - 14 and day < team_today()
  group by day
  having sum(pushes) + sum(prs_merged) > 0
      or sum(claude_seconds + codex_seconds_est) > 0
)
select count(*)        as days_counted,
       avg(tool_hours) as avg_tool_hours,
       avg(pushes)     as avg_pushes,
       avg(merges)     as avg_merges
from por_dia;

create or replace view v_dora_deploy_frequency as
select repo,
       date_trunc('week', deployed_at)::date as week,
       count(*)                              as deploys,
       count(*) filter (where is_rollback)   as rollbacks
from deployments
where is_production and status = 'success'
group by 1, 2;

create or replace view v_dora_lead_time as
select pr.repo,
       pr.number,
       pr.merged_at,
       case when dep.deployed_at is not null then 'to_deploy' else 'to_merge' end as basis,
       extract(epoch from (coalesce(dep.deployed_at, pr.merged_at) - pr.created_at)) / 3600.0
         as hours
from pull_requests pr
left join lateral (
  select d.deployed_at
  from deployments d
  where d.repo = pr.repo
    and d.is_production
    and d.status = 'success'
    and d.deployed_at >= pr.merged_at
  order by d.deployed_at
  limit 1
) dep on true
where pr.state = 'merged'
  and pr.merged_at is not null
  and pr.created_at is not null
  and not pr.is_bot;

/**
 * Fallos de cambio, detectados de verdad.
 *
 * Antes `is_rollback` no lo marcaba nadie, asi que la tasa de fallo salia siempre
 * 0 %: un numero que parece una buena noticia y no es nada. Ahora se detectan
 * cuatro senales, todas a partir de metadatos:
 */
create or replace view v_change_failures as
-- Un despliegue a produccion que fallo.
select repo, deployed_at as at, 'deploy_failed'::text as kind
from deployments
where is_production and status in ('failure', 'error')

union all
-- Una reversion: volver a desplegar un commit que ya estuvo en produccion,
-- despues de que se desplegara otro distinto entre medias.
select d.repo, d.deployed_at, 'rollback'
from deployments d
where d.is_production and d.status = 'success' and d.sha is not null
  and exists (
    select 1 from deployments prev
    where prev.repo = d.repo and prev.is_production and prev.status = 'success'
      and prev.sha = d.sha and prev.deployed_at < d.deployed_at
      and exists (
        select 1 from deployments mid
        where mid.repo = d.repo and mid.is_production and mid.status = 'success'
          and mid.deployed_at > prev.deployed_at and mid.deployed_at < d.deployed_at
          and mid.sha is distinct from d.sha
      )
  )

union all
-- Marcado a mano como reversion.
select repo, deployed_at, 'rollback'
from deployments
where is_production and is_rollback

union all
-- Un PR de reversion mergeado. El boton "Revert" de GitHub crea la rama
-- `revert-<numero>-<rama original>`.
select repo, merged_at, 'revert_pr'
from pull_requests
where state = 'merged' and merged_at is not null and head_ref ~ '^revert-[0-9]+-';

create or replace view v_dora_change_failure as
with deploys as (
  select repo, date_trunc('week', deployed_at)::date as week, count(*) as deploys
  from deployments
  where is_production
  group by 1, 2
),
failures as (
  select repo, date_trunc('week', at)::date as week, count(*) as failures
  from v_change_failures
  group by 1, 2
)
select coalesce(d.repo, f.repo)        as repo,
       coalesce(d.week, f.week)        as week,
       coalesce(d.deploys, 0)          as deploys,
       coalesce(f.failures, 0)         as failures,
       case when coalesce(d.deploys, 0) > 0
            then least(1.0, coalesce(f.failures, 0)::double precision / d.deploys)
       end                             as failure_rate
from deploys d
full join failures f on f.repo = d.repo and f.week = d.week;

-- Tiempo de restauracion: solo la rama principal. Que una rama de trabajo falle y
-- se arregle es el ciclo normal de desarrollo, no una caida que restaurar.
create or replace view v_dora_restore_time as
with failures as (
  select repo, branch, completed_at as failed_at
  from ci_runs
  where conclusion = 'failure'
    and completed_at is not null
    and branch in ('main', 'master')
)
select f.repo, f.branch, f.failed_at,
       ok.completed_at as restored_at,
       extract(epoch from (ok.completed_at - f.failed_at)) / 3600.0 as hours
from failures f
left join lateral (
  select c.completed_at
  from ci_runs c
  where c.repo = f.repo and c.branch = f.branch
    and c.conclusion = 'success' and c.completed_at > f.failed_at
  order by c.completed_at
  limit 1
) ok on true;

-- Ciclo desglosado. `greatest(0, ...)`: una revision hecha mientras el PR era
-- borrador daba horas NEGATIVAS hasta la primera revision, y una sola bastaba para
-- torcer la mediana.
create or replace view v_pr_cycle_breakdown as
select repo, number, author_login, merged_at,
       additions + deletions as size_lines,
       changed_files,
       greatest(0, extract(epoch from (first_review_at - coalesce(ready_at, created_at))) / 3600.0)
         as hours_to_first_review,
       greatest(0, extract(epoch from (approved_at - first_review_at)) / 3600.0)
         as hours_review_to_approval,
       greatest(0, extract(epoch from (merged_at - approved_at)) / 3600.0)
         as hours_approval_to_merge,
       greatest(0, extract(epoch from (merged_at - coalesce(ready_at, created_at))) / 3600.0)
         as hours_total
from pull_requests
where state = 'merged' and merged_at is not null and not is_bot;

-- Mismo criterio que el desglose: desde que el PR esta LISTO, no desde que se abrio
-- como borrador. Antes cada vista media desde un sitio distinto.
create or replace view v_pr_size_buckets as
select case
         when additions + deletions <  10 then '1. XS (<10)'
         when additions + deletions <  50 then '2. S (10-49)'
         when additions + deletions < 200 then '3. M (50-199)'
         when additions + deletions < 600 then '4. L (200-599)'
         else                                  '5. XL (600+)'
       end as bucket,
       count(*) as prs,
       percentile_cont(0.5) within group (
         order by greatest(0, extract(epoch from (first_review_at - coalesce(ready_at, created_at))) / 3600.0)
       ) as median_hours_to_review,
       percentile_cont(0.5) within group (
         order by greatest(0, extract(epoch from (merged_at - coalesce(ready_at, created_at))) / 3600.0)
       ) as median_hours_to_merge
from pull_requests
where state = 'merged' and additions is not null and merged_at is not null and not is_bot
group by 1;

create or replace view v_pr_cycle_time as
select pe.id         as person_id,
       pe.display_name,
       pr.repo,
       pr.number     as pr_number,
       pr.created_at as pr_created_at,
       pr.merged_at  as pr_merged_at,
       pr.first_review_at,
       pr.additions,
       pr.deletions,
       pr.changed_files,
       greatest(0, extract(epoch from (pr.merged_at - pr.created_at)) / 3600.0)
         as hours_open_to_merge,
       greatest(0, extract(epoch from (pr.first_review_at - pr.created_at)) / 3600.0)
         as hours_to_first_review
from pull_requests pr
left join people pe on lower(pe.github_login) = lower(pr.author_login)
where pr.state = 'merged' and pr.merged_at is not null and not pr.is_bot;

-- Senales de calidad. Se anade "mergeados sin ninguna revision": un PR que entra
-- sin que nadie lo mire es un riesgo de proceso, y antes era invisible.
create or replace view v_quality_signals as
select date_trunc('week', coalesce(pr.merged_at, pr.closed_at))::date as week,
       count(*)                                        as prs_closed,
       count(*) filter (where pr.state = 'merged')     as merged,
       count(*) filter (where pr.state = 'closed')     as abandoned,
       case when count(*) > 0
            then count(*) filter (where pr.state = 'closed')::double precision / count(*)
       end                                             as abandon_rate,
       count(*) filter (
         where pr.state = 'merged'
           and not exists (
             select 1 from reviews r
             where r.repo = pr.repo and r.pr_number = pr.number
               and not r.is_bot and not r.is_self
               and r.submitted_at <= pr.merged_at
           )
       )                                               as merged_without_review
from pull_requests pr
where coalesce(pr.merged_at, pr.closed_at) is not null and not pr.is_bot
group by 1;

create or replace view v_wip_by_day as
select d::date as day,
       count(*) as open_prs
from generate_series(
       (select min(created_at)::date from pull_requests where not is_bot),
       team_today(),
       interval '1 day'
     ) d
join pull_requests pr
  on not pr.is_bot
 and pr.created_at < d + interval '1 day'
 and (pr.closed_at is null and pr.merged_at is null
      or coalesce(pr.merged_at, pr.closed_at) >= d + interval '1 day')
group by 1;

-- Revisiones: sin bots ni autorrevisiones. La carga de revision es para dar
-- credito al trabajo de revisar a otros; comentar el PR propio no lo es.
create or replace view v_review_load as
select p.id as person_id,
       p.display_name,
       date_trunc('week', r.submitted_at)::date as week,
       count(*)                                              as reviews,
       count(*) filter (where r.state = 'approved')          as approvals,
       count(*) filter (where r.state = 'changes_requested') as changes_requested,
       count(distinct r.repo || '#' || r.pr_number)          as prs_touched,
       coalesce(sum(rc.comments), 0)                         as comments
from reviews r
join people p on lower(p.github_login) = lower(r.reviewer_login)
left join (
  select review_id, count(*) as comments
  from review_comments
  where review_id is not null
  group by 1
) rc on rc.review_id = r.external_id
where not r.is_bot and not r.is_self
group by 1, 2, 3;

create or replace view v_review_pairs as
select reviewer_login,
       pr_author_login,
       count(*)          as reviews,
       max(submitted_at) as last_review
from reviews
where reviewer_login is not null
  and pr_author_login is not null
  and not is_bot
  and not is_self
group by 1, 2;

create or replace view v_rubber_stamp as
select date_trunc('week', r.submitted_at)::date as week,
       count(*)                                   as approvals,
       count(*) filter (where c.comments is null) as without_comments,
       case when count(*) > 0
            then count(*) filter (where c.comments is null)::double precision / count(*)
       end as rate
from reviews r
left join (
  select repo, pr_number, lower(commenter_login) as commenter, count(*) as comments
  from review_comments
  group by 1, 2, 3
) c on c.repo = r.repo
   and c.pr_number = r.pr_number
   and c.commenter = lower(r.reviewer_login)
where r.state = 'approved' and not r.is_bot and not r.is_self
group by 1;

-- Actividad sin atribuir, sin bots: su push de gh-pages o de dependencias no es de
-- nadie del equipo, y llenaba la lista de "falta configurar git" de falsos avisos.
create or replace view v_unmapped_git_activity as
select coalesce(lower(g.author_email), 'login:' || g.actor_login) as identity,
       count(*)           as events,
       min(g.occurred_at) as first_seen,
       max(g.occurred_at) as last_seen
from v_git_events_resolved g
where g.person_id is null
  and coalesce(g.actor_login, '') not like '%[bot]'
group by 1
order by 2 desc;

-- ---------------------------------------------------------------------------
-- 8. Tablero en vivo: recalculo aplazado
-- ---------------------------------------------------------------------------

-- Cuando llega un evento y el tablero se calculo hace menos de 10 s (rafagas de
-- CI), el webhook no recalcula: apunta aqui que hay algo pendiente. La vista
-- "Ahora" recalcula si `dirty_since` es posterior a `computed_at`. Asi una rafaga
-- cuesta un calculo y el ultimo evento nunca se pierde.
alter table live_snapshot add column dirty_since timestamptz;

-- ---------------------------------------------------------------------------
-- 9. Borrado de los datos de demostracion
-- ---------------------------------------------------------------------------

/**
 * Borra los datos sembrados para la demo. Solo toca filas con las marcas de la
 * semilla (repos `demo/`, equipos `demo-pc-`, personas `dddddddd-...`), asi que no
 * puede alcanzar datos reales.
 *
 * Existe para que no haga falta `psql`: el panel la llama desde Salud.
 *
 * Se ejecuta con los permisos de quien la llama, no con los de su propietario: las
 * tablas tienen RLS forzado, que tambien se aplica al propietario, y quien salta
 * RLS es `service_role`, que es quien la llama desde el panel.
 */
-- Las funciones auxiliares de la semilla solo se usan mientras se siembra (y
-- demo.sql las vuelve a crear si se repite). Fuera de eso sobran, y sin search_path
-- fijo el asesor de seguridad de Supabase las marca.
drop function if exists demo_rand(text);
drop function if exists demo_between(text, double precision, double precision);

create or replace function clear_demo_data() returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  result jsonb := '{}'::jsonb;
  n      bigint;
begin
  delete from commit_files    where repo like 'demo/%';
  get diagnostics n = row_count; result := result || jsonb_build_object('commit_files', n);
  delete from review_comments where repo like 'demo/%';
  get diagnostics n = row_count; result := result || jsonb_build_object('review_comments', n);
  delete from reviews         where repo like 'demo/%';
  get diagnostics n = row_count; result := result || jsonb_build_object('reviews', n);
  delete from ci_runs         where repo like 'demo/%';
  get diagnostics n = row_count; result := result || jsonb_build_object('ci_runs', n);
  delete from deployments     where repo like 'demo/%';
  get diagnostics n = row_count; result := result || jsonb_build_object('deployments', n);
  delete from pull_requests   where repo like 'demo/%';
  get diagnostics n = row_count; result := result || jsonb_build_object('pull_requests', n);
  delete from git_events      where repo like 'demo/%' or meta->>'source' = 'demo';
  get diagnostics n = row_count; result := result || jsonb_build_object('git_events', n);
  delete from tool_metrics    where hostname like 'demo-pc-%';
  get diagnostics n = row_count; result := result || jsonb_build_object('tool_metrics', n);
  delete from tool_events     where hostname like 'demo-pc-%';
  get diagnostics n = row_count; result := result || jsonb_build_object('tool_events', n);
  delete from daily_rollup    where person_id::text like 'dddddddd%';
  get diagnostics n = row_count; result := result || jsonb_build_object('daily_rollup', n);
  delete from devices         where hostname like 'demo-pc-%';
  get diagnostics n = row_count; result := result || jsonb_build_object('devices', n);
  delete from people          where id::text like 'dddddddd%';
  get diagnostics n = row_count; result := result || jsonb_build_object('people', n);

  -- Restos de la semilla, por si una carga se interrumpio a medias. Eliminarlos
  -- exige ser su propietario; desde el panel no se es, y no pasa nada: son
  -- auxiliares inertes. Lo que importa, las filas, ya esta borrado.
  begin
    drop table if exists demo_tmp_pr_full;
    drop table if exists demo_tmp_pr_times;
    drop table if exists demo_tmp_prs;
    drop table if exists demo_tmp_usage;
    drop table if exists demo_tmp_days;
    drop table if exists demo_tmp_people;
    drop function if exists demo_rand(text);
    drop function if exists demo_between(text, double precision, double precision);
  exception when insufficient_privilege then
    null;
  end;

  -- El tablero guardado se calculo con la demo: se marca como pendiente para que
  -- la siguiente visita lo recalcule sin ella.
  update live_snapshot set dirty_since = now() where id = 1;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Cierre de acceso para lo nuevo
-- ---------------------------------------------------------------------------

-- Mismo bloque que 0007, porque lo que se crea despues no hereda el cierre de
-- forma fiable: hay que repetirlo en cada migracion que anade objetos.
do $$
declare
  r record;
  supabase_roles boolean;
begin
  select exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated')
    into supabase_roles;

  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('alter table public.%I force row level security', r.tablename);
  end loop;

  if not supabase_roles then
    raise notice 'Roles anon/authenticated no encontrados: se omiten los revokes (Postgres local).';
    return;
  end if;

  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
  loop
    execute format('revoke all on public.%I from anon, authenticated', r.relname);
  end loop;

  -- Las funciones se crean ejecutables por PUBLIC, y anon y authenticated lo
  -- heredan de ahi aunque se les revoque a ellos. Hay que quitarselo a PUBLIC.
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from anon, authenticated, public', r.fn);
  end loop;
  execute 'alter default privileges in schema public revoke execute on functions from public';

  -- Permisos explicitos para el servidor. Supabase ya se los da por defecto, pero
  -- al revocar PUBLIC conviene no depender de eso: sin ellos el panel y la ingesta
  -- dejarian de funcionar de golpe.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant select, insert, update, delete on all tables in schema public to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
    execute 'grant execute on all functions in schema public to service_role';
    execute 'alter default privileges in schema public grant execute on functions to service_role';
  end if;
end $$;
