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
  select round(estimated_seconds) into v from v_codex_estimated_time;
  assert v = 600, format('tiempo estimado de Codex: esperado 600 s, obtenido %s', v);

  -- Lead time de PR1: abierto 09-15 09:00, desplegado 09-16 12:00 = 27 h.
  select round(hours::numeric) into v from v_dora_lead_time where number = 1;
  assert v = 27, format('lead time PR1: esperado 27 h, obtenido %s', v);

  -- El basis debe decir que se midio hasta el despliegue, no hasta el merge.
  assert (select basis from v_dora_lead_time where number = 1) = 'to_deploy',
    'el lead time deberia medirse hasta el despliegue cuando hay despliegues';

  -- Ciclo desglosado de PR1: 5 h a revision, 19 h a aprobacion, 2 h a merge.
  select round(hours_to_first_review::numeric) into v from v_pr_cycle_breakdown where number = 1;
  assert v = 5, format('PR1 horas a primera revision: esperado 5, obtenido %s', v);
  select round(hours_approval_to_merge::numeric) into v from v_pr_cycle_breakdown where number = 1;
  assert v = 2, format('PR1 horas de aprobacion a merge: esperado 2, obtenido %s', v);

  -- Churn: de 3 archivos tocados, solo h_a se retoca dentro de 7 dias.
  select files_reworked into n from v_churn;
  assert n = 1, format('archivos retrabajados: esperado 1, obtenido %s', n);

  -- Restauracion: main falla 09-25 08:04 y vuelve a verde 12:05 = 4 h.
  select round(hours::numeric) into v from v_dora_restore_time where branch = 'main';
  assert v = 4, format('tiempo de restauracion de main: esperado 4 h, obtenido %s', v);

  -- Tasa de fallo del cambio: 1 rollback de 3 despliegues.
  select round(failure_rate::numeric, 2) into v from v_dora_change_failure;
  assert v = 0.33, format('tasa de fallo: esperado 0.33, obtenido %s', v);

  -- Carga de revision: Ana hizo 2 revisiones con 2 comentarios.
  select reviews into n from v_review_load where display_name = 'Ana';
  assert n = 2, format('revisiones de Ana: esperado 2, obtenido %s', n);
  select comments into n from v_review_load where display_name = 'Ana';
  assert n = 2, format('comentarios de Ana: esperado 2, obtenido %s', n);

  -- Aprobacion de sello: la de Luis no lleva comentarios.
  select without_comments into n from v_rubber_stamp;
  assert n = 1, format('aprobaciones sin comentarios: esperado 1, obtenido %s', n);

  -- Test inestable: sha3 falla y pasa con el mismo commit.
  select count(*) into n from v_flaky_ci;
  assert n = 1, format('tests inestables detectados: esperado 1, obtenido %s', n);

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

  raise notice 'Retencion: el detalle se borra y el agregado se conserva';
end $$;
