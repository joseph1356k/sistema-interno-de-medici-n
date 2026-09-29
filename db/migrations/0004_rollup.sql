-- Agregados precalculados, tablero en vivo y retencion.
--
-- Motivo: consultar `tool_metrics` cruda para pintar un ano de tendencia no
-- escala. Las vistas historicas y las proyecciones leen SOLO de `daily_rollup`;
-- el dia en curso se calcula al vuelo, que es poco dato.

-- ---------------------------------------------------------------------------
-- Rollup diario por persona
-- ---------------------------------------------------------------------------

create table daily_rollup (
  person_id         uuid    not null references people(id) on delete cascade,
  day               date    not null,

  claude_seconds    double precision not null default 0,
  codex_seconds_est double precision not null default 0,
  sessions          integer not null default 0,
  tokens            bigint  not null default 0,
  cost_usd          double precision not null default 0,

  edits_accepted    integer not null default 0,
  edits_rejected    integer not null default 0,
  lines_added       integer not null default 0,
  lines_removed     integer not null default 0,

  pushes            integer not null default 0,
  commits           integer not null default 0,
  prs_opened        integer not null default 0,
  prs_merged        integer not null default 0,
  reviews_given     integer not null default 0,
  review_comments   integer not null default 0,

  computed_at       timestamptz not null default now(),

  primary key (person_id, day)
);

comment on table daily_rollup is
  'La actividad sin atribuir NO entra aqui a proposito: aparece en '
  'v_unmapped_git_activity, donde se ve que hay que arreglar el mapeo, en vez de '
  'diluirse en un agregado.';

create index daily_rollup_day_idx on daily_rollup (day desc);

/**
 * Recalcula el rollup de un dia. Idempotente: borra y reinserta, asi que se puede
 * reejecutar sin duplicar. La usa el cron nocturno, y tambien sirve para rellenar
 * dias sueltos a mano.
 */
create or replace function rollup_day(target date) returns integer
language plpgsql as $$
declare
  affected integer;
begin
  delete from daily_rollup where day = target;

  insert into daily_rollup (
    person_id, day, claude_seconds, codex_seconds_est, sessions, tokens, cost_usd,
    edits_accepted, edits_rejected, lines_added, lines_removed,
    pushes, commits, prs_opened, prs_merged, reviews_given, review_comments
  )
  select
    p.id,
    target,
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

  -- Telemetria de herramientas, atribuida por equipo.
  left join (
    select d.person_id,
           sum(m.value) filter (
             where m.metric = 'claude_code.active_time.total') as claude_seconds,
           sum(m.value) filter (
             where m.metric in ('claude_code.token.usage','codex.turn.token_usage')
           ) as tokens,
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
    where m.observed_at >= target and m.observed_at < target + 1
      and d.person_id is not null
    group by d.person_id
  ) tm on tm.person_id = p.id

  -- Tiempo estimado de Codex, derivado de huecos entre eventos.
  left join (
    select person_id,
           sum(estimated_seconds) as codex_seconds,
           sum(sessions)          as sessions
    from v_codex_estimated_time
    where day = target and person_id is not null
    group by person_id
  ) cx on cx.person_id = p.id

  -- Push y commits: de git_events, atribuidos por email de commit o por login.
  left join (
    select person_id,
           count(*)          as pushes,
           sum(commit_count) as commits
    from v_git_events_resolved
    where kind in ('push', 'force_push')
      and occurred_at >= target and occurred_at < target + 1
      and person_id is not null
    group by person_id
  ) g on g.person_id = p.id

  -- PRs: de `pull_requests`, que es la tabla autoritativa del estado. Contarlos
  -- desde git_events daba siempre cero, porque ahi solo hay hechos sueltos y el
  -- estado real vive en pull_requests.
  left join (
    select pe.id as person_id,
           count(*) filter (
             where pr.created_at >= target and pr.created_at < target + 1
           ) as prs_opened,
           count(*) filter (
             where pr.merged_at >= target and pr.merged_at < target + 1
           ) as prs_merged
    from people pe
    join pull_requests pr on lower(pr.author_login) = lower(pe.github_login)
    group by pe.id
  ) pq on pq.person_id = p.id

  -- Revisiones hechas: trabajo que normalmente no se cuenta.
  left join (
    select pe.id as person_id,
           count(distinct r.id)  as reviews_given,
           count(distinct rc.id) as review_comments
    from people pe
    left join reviews r
      on lower(r.reviewer_login) = lower(pe.github_login)
     and r.submitted_at >= target and r.submitted_at < target + 1
    left join review_comments rc
      on lower(rc.commenter_login) = lower(pe.github_login)
     and rc.created_at >= target and rc.created_at < target + 1
    group by pe.id
  ) rv on rv.person_id = p.id

  where p.active
    -- No se guardan filas completamente vacias: una persona sin actividad ese dia
    -- no necesita fila, y el panel ya muestra cero cuando no la encuentra.
    and (tm.person_id is not null or cx.person_id is not null
         or g.person_id is not null
         or coalesce(pq.prs_opened, 0) + coalesce(pq.prs_merged, 0) > 0
         or coalesce(rv.reviews_given, 0) > 0);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tablero en vivo
-- ---------------------------------------------------------------------------

-- Una sola fila. La vista "Ahora" se refresca cada 60 s, asi que hace un select
-- de una fila en vez de veinte agregaciones.
create table live_snapshot (
  id          integer     primary key default 1 check (id = 1),
  payload     jsonb       not null,
  computed_at timestamptz not null default now()
);

insert into live_snapshot (id, payload) values (1, '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- Retencion
-- ---------------------------------------------------------------------------

/**
 * Aplica lo que PRIVACY.md promete al equipo: 90 dias de detalle, y despues solo
 * los agregados de daily_rollup. Es una funcion y un cron, no la memoria de
 * nadie.
 *
 * Antes de borrar se asegura de que el rollup de cada dia afectado existe, para
 * no perder el agregado junto con el detalle.
 */
create or replace function apply_retention(keep_days integer default 90)
returns table (deleted_metrics bigint, deleted_events bigint, rolled_days integer)
language plpgsql as $$
declare
  cutoff date := (now() - make_interval(days => keep_days))::date;
  d date;
  rolled integer := 0;
  dm bigint;
  de bigint;
begin
  -- Rellena el rollup de cualquier dia antiguo que aun no lo tenga.
  for d in
    select distinct observed_at::date
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

  return query select dm, de, rolled;
end;
$$;
