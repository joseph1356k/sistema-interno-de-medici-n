-- Catalogo de metricas: DORA, flujo, revision, CI, retrabajo y ROI.

-- ---------------------------------------------------------------------------
-- Retrabajo: el problema de privacidad y como se resuelve
-- ---------------------------------------------------------------------------

/**
 * "Que archivos se vuelven a tocar poco despues de mergearse" es la mejor senal
 * de salud del codigo disponible desde metadatos. Pero exige saber QUE archivos, y
 * las rutas de archivo estan en la lista de lo que este sistema nunca guarda.
 *
 * Solucion: se guarda un HMAC de la ruta con una sal secreta, nunca la ruta. El
 * sistema puede contar "3 archivos se retocaron en 5 dias" sin que la base de
 * datos contenga ninguna ruta.
 *
 * Es opcional: sin FILE_HASH_SALT configurada no se recoge nada y el panel lo dice
 * en vez de mostrar un cero engañoso.
 *
 * Limite honesto: quien tenga la sal Y acceso al repositorio puede rehacer los
 * hashes y deducir los archivos. Protege la base de datos, no es anonimato fuerte.
 */
create table commit_files (
  id           bigserial   primary key,
  dedup_key    text        not null unique,
  repo         text        not null,
  sha          text        not null,
  -- HMAC-SHA256(salt, ruta). Nunca la ruta.
  path_hash    text        not null,
  change_type  text        not null,  -- added | modified | removed
  committed_at timestamptz not null,
  ingested_at  timestamptz not null default now()
);

create index commit_files_path_idx on commit_files (repo, path_hash, committed_at);

-- ---------------------------------------------------------------------------
-- DORA
-- ---------------------------------------------------------------------------

-- 1. Frecuencia de despliegue, por semana.
create or replace view v_dora_deploy_frequency as
select repo,
       date_trunc('week', deployed_at)::date as week,
       count(*)                              as deploys,
       count(*) filter (where is_rollback)   as rollbacks
from deployments
group by 1, 2;

-- 2. Lead time del cambio: PR abierto -> primer despliegue posterior al merge.
-- Si el repositorio no registra despliegues, cae a abierto -> merge y lo indica
-- en `basis`, para no comparar peras con manzanas entre repos.
create or replace view v_dora_lead_time as
select pr.repo,
       pr.number,
       pr.merged_at,
       case when dep.deployed_at is not null then 'to_deploy' else 'to_merge' end
         as basis,
       extract(epoch from (
         coalesce(dep.deployed_at, pr.merged_at) - pr.created_at
       )) / 3600.0 as hours
from pull_requests pr
left join lateral (
  select d.deployed_at
  from deployments d
  where d.repo = pr.repo and d.deployed_at >= pr.merged_at
  order by d.deployed_at
  limit 1
) dep on true
where pr.state = 'merged' and pr.merged_at is not null and pr.created_at is not null;

-- 3. Tasa de fallo del cambio.
create or replace view v_dora_change_failure as
select repo,
       date_trunc('week', deployed_at)::date as week,
       count(*)                                          as deploys,
       count(*) filter (where is_rollback)               as failures,
       case when count(*) > 0
            then count(*) filter (where is_rollback)::double precision / count(*)
       end as failure_rate
from deployments
group by 1, 2;

-- 4. Tiempo de restauracion: cuanto tarda una rama en volver a verde.
-- Empareja cada fallo con el primer exito posterior en la misma rama.
create or replace view v_dora_restore_time as
with failures as (
  select repo, branch, completed_at as failed_at
  from ci_runs
  where conclusion = 'failure' and completed_at is not null
)
select f.repo,
       f.branch,
       f.failed_at,
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

-- ---------------------------------------------------------------------------
-- Flujo de entrega
-- ---------------------------------------------------------------------------

-- Ciclo DESGLOSADO. El desglose es lo que dice donde esta el atasco: un ciclo de
-- 5 dias con 4 esperando revision es un problema muy distinto a 4 en CI.
create or replace view v_pr_cycle_breakdown as
select repo,
       number,
       author_login,
       merged_at,
       additions + deletions as size_lines,
       changed_files,
       extract(epoch from (first_review_at - coalesce(ready_at, created_at))) / 3600.0
         as hours_to_first_review,
       extract(epoch from (approved_at - first_review_at)) / 3600.0
         as hours_review_to_approval,
       extract(epoch from (merged_at - approved_at)) / 3600.0
         as hours_approval_to_merge,
       extract(epoch from (merged_at - coalesce(ready_at, created_at))) / 3600.0
         as hours_total
from pull_requests
where state = 'merged' and merged_at is not null;

-- Tamano de PR por tramos. Los PRs grandes son la causa mas comun de revisiones
-- lentas; verlo por tramos es mas legible que una nube de puntos.
create or replace view v_pr_size_buckets as
select case
         when additions + deletions <  10  then '1. XS (<10)'
         when additions + deletions <  50  then '2. S (10-49)'
         when additions + deletions < 200  then '3. M (50-199)'
         when additions + deletions < 600  then '4. L (200-599)'
         else                                   '5. XL (600+)'
       end as bucket,
       count(*)                                  as prs,
       percentile_cont(0.5) within group (
         order by extract(epoch from (first_review_at - created_at)) / 3600.0
       ) as median_hours_to_review,
       percentile_cont(0.5) within group (
         order by extract(epoch from (merged_at - created_at)) / 3600.0
       ) as median_hours_to_merge
from pull_requests
where state = 'merged' and additions is not null and merged_at is not null
group by 1;

-- WIP historico: cuantos PRs estaban abiertos al final de cada dia. Se reconstruye
-- de created_at/closed_at, sin necesidad de haber guardado instantaneas.
create or replace view v_wip_by_day as
select d::date as day,
       count(*) as open_prs
from generate_series(
       (select min(created_at)::date from pull_requests),
       current_date,
       interval '1 day'
     ) d
join pull_requests pr
  on pr.created_at < d + interval '1 day'
 and (pr.closed_at is null and pr.merged_at is null
      or coalesce(pr.merged_at, pr.closed_at) >= d + interval '1 day')
group by 1;

-- ---------------------------------------------------------------------------
-- Revision de codigo
-- ---------------------------------------------------------------------------

-- Carga de revision por persona. Mide trabajo que normalmente no se ve y por el
-- que nadie recibe credito.
create or replace view v_review_load as
select p.id as person_id,
       p.display_name,
       date_trunc('week', r.submitted_at)::date as week,
       count(*)                                          as reviews,
       count(*) filter (where r.state = 'approved')       as approvals,
       count(*) filter (where r.state = 'changes_requested') as changes_requested,
       count(distinct r.repo || '#' || r.pr_number)       as prs_touched,
       coalesce(sum(rc.comments), 0)                      as comments
from reviews r
join people p on lower(p.github_login) = lower(r.reviewer_login)
left join (
  select review_id, count(*) as comments
  from review_comments
  where review_id is not null
  group by 1
) rc on rc.review_id = r.external_id
group by 1, 2, 3;

-- Reparto: quien revisa a quien. Detecta cuellos de botella de una sola persona.
create or replace view v_review_pairs as
select reviewer_login,
       pr_author_login,
       count(*)          as reviews,
       max(submitted_at) as last_review
from reviews
where reviewer_login is not null
  and pr_author_login is not null
  and lower(reviewer_login) <> lower(pr_author_login)
group by 1, 2;

-- Aprobaciones sin ningun comentario: senal de revision de sello. No es una
-- acusacion (un PR de una linea no necesita comentarios); es una senal a mirar
-- cuando la proporcion es alta en PRs grandes.
--
-- Se cuentan los comentarios de ese revisor en TODO el PR, no solo en esa
-- revision concreta. Quien pidio cambios con comentarios y luego aprueba SI
-- participo, y contarlo como sello seria una lectura falsa.
create or replace view v_rubber_stamp as
select date_trunc('week', r.submitted_at)::date as week,
       count(*)                                          as approvals,
       count(*) filter (where c.comments is null)        as without_comments,
       case when count(*) > 0
            then count(*) filter (where c.comments is null)::double precision
                 / count(*)
       end as rate
from reviews r
left join (
  select repo, pr_number, lower(commenter_login) as commenter, count(*) as comments
  from review_comments
  group by 1, 2, 3
) c on c.repo = r.repo
   and c.pr_number = r.pr_number
   and c.commenter = lower(r.reviewer_login)
where r.state = 'approved'
group by 1;

-- ---------------------------------------------------------------------------
-- Salud de CI
-- ---------------------------------------------------------------------------

create or replace view v_ci_health as
select repo,
       date_trunc('week', completed_at)::date as week,
       name,
       count(*)                                        as runs,
       count(*) filter (where conclusion = 'success')  as passed,
       count(*) filter (where conclusion = 'failure')  as failed,
       case when count(*) > 0
            then count(*) filter (where conclusion = 'failure')::double precision
                 / count(*)
       end as failure_rate,
       percentile_cont(0.5) within group (order by duration_seconds)
         as median_duration_seconds
from ci_runs
where completed_at is not null and conclusion is not null
group by 1, 2, 3;

-- Iteraciones hasta verde por PR: cuantos intentos de CI hizo falta.
create or replace view v_ci_iterations as
select pr.repo,
       pr.number,
       pr.merged_at,
       count(c.*)                                       as total_runs,
       count(c.*) filter (where c.conclusion = 'failure') as failed_runs
from pull_requests pr
join ci_runs c on c.repo = pr.repo and c.head_sha = pr.head_sha
where pr.state = 'merged'
group by 1, 2, 3;

-- Tests inestables: el MISMO workflow que falla y pasa sobre el MISMO commit. Si
-- el codigo no cambio y el resultado si, el problema es el test, no el cambio.
create or replace view v_flaky_ci as
select repo,
       name,
       head_sha,
       count(*) filter (where conclusion = 'failure') as failures,
       count(*) filter (where conclusion = 'success') as successes,
       max(completed_at)                             as last_seen
from ci_runs
where conclusion in ('success', 'failure')
group by 1, 2, 3
having count(*) filter (where conclusion = 'failure') > 0
   and count(*) filter (where conclusion = 'success') > 0;

-- ---------------------------------------------------------------------------
-- Retrabajo y calidad
-- ---------------------------------------------------------------------------

-- Archivos tocados de nuevo en los 7 dias siguientes. Sin rutas: solo el conteo.
create or replace view v_churn as
select cf.repo,
       date_trunc('week', cf.committed_at)::date as week,
       count(*)                                   as files_touched,
       count(*) filter (where again.path_hash is not null) as files_reworked,
       case when count(*) > 0
            then count(*) filter (
                   where again.path_hash is not null
                 )::double precision / count(*)
       end as rework_rate
from commit_files cf
left join lateral (
  select 1 as path_hash
  from commit_files later
  where later.repo = cf.repo
    and later.path_hash = cf.path_hash
    and later.committed_at > cf.committed_at
    and later.committed_at <= cf.committed_at + interval '7 days'
  limit 1
) again on true
where cf.change_type in ('added', 'modified')
group by 1, 2;

-- Senales de calidad que no necesitan rutas de archivo.
create or replace view v_quality_signals as
select date_trunc('week', coalesce(merged_at, closed_at))::date as week,
       count(*)                                          as prs_closed,
       count(*) filter (where state = 'merged')           as merged,
       count(*) filter (where state = 'closed')           as abandoned,
       case when count(*) > 0
            then count(*) filter (where state = 'closed')::double precision / count(*)
       end as abandon_rate
from pull_requests
where coalesce(merged_at, closed_at) is not null
group by 1;

-- ---------------------------------------------------------------------------
-- ROI de la IA
-- ---------------------------------------------------------------------------

-- Coste por PR mergeado: la cifra que responde "vale lo que cuesta?".
create or replace view v_cost_per_pr as
select r.day,
       sum(r.cost_usd)     as cost_usd,
       sum(r.prs_merged)   as prs_merged,
       case when sum(r.prs_merged) > 0
            then sum(r.cost_usd) / sum(r.prs_merged)
       end as cost_per_pr
from daily_rollup r
group by 1;

-- Distribucion horaria de commits, A NIVEL DE EQUIPO. Un patron sostenido de
-- madrugada o fin de semana es una alerta de riesgo de quemarse, no una medalla.
-- Deliberadamente sin desglose por persona.
create or replace view v_commit_hours as
select extract(hour from occurred_at)::integer as hour_utc,
       extract(isodow from occurred_at)::integer as iso_dow,
       count(*) as events
from git_events
where kind in ('push', 'force_push')
group by 1, 2;

-- ---------------------------------------------------------------------------
-- Una sola fuente de verdad para el tiempo de ciclo
-- ---------------------------------------------------------------------------

/**
 * `v_pr_cycle_time` se definio en 0002 sobre git_events, cuando aun no existia la
 * tabla `pull_requests`. Se redefine aqui sobre pull_requests, que es el estado
 * autoritativo y tiene los hitos intermedios. Se conservan los nombres de columna
 * para no romper el codigo que ya la consulta.
 */
create or replace view v_pr_cycle_time as
select pe.id                     as person_id,
       pe.display_name,
       pr.repo,
       pr.number                 as pr_number,
       pr.created_at             as pr_created_at,
       pr.merged_at              as pr_merged_at,
       pr.first_review_at,
       pr.additions,
       pr.deletions,
       pr.changed_files,
       extract(epoch from (pr.merged_at - pr.created_at)) / 3600.0
         as hours_open_to_merge,
       extract(epoch from (pr.first_review_at - pr.created_at)) / 3600.0
         as hours_to_first_review
from pull_requests pr
left join people pe on lower(pe.github_login) = lower(pr.author_login)
where pr.state = 'merged' and pr.merged_at is not null;
