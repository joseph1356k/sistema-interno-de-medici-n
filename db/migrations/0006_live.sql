-- Vistas del tablero en vivo.

/**
 * Actividad del dia en curso.
 *
 * Lee de `daily_rollup`, no reimplementa la agregacion: `refreshSnapshot()` llama
 * a `rollup_day(current_date)` antes de consultar. Recalcular un solo dia es
 * barato, y asi la logica de agregacion vive en un unico sitio y no puede
 * divergir entre "hoy" y "el historico".
 *
 * Se incluye a TODA persona activa, con ceros si no hay fila. Una fila en cero es
 * informacion; una fila ausente parece un fallo del sistema.
 */
create or replace view v_today_activity as
select p.id                                  as person_id,
       p.display_name,
       coalesce(r.claude_seconds, 0)         as claude_seconds,
       coalesce(r.codex_seconds_est, 0)      as codex_seconds_est,
       coalesce(r.sessions, 0)               as sessions,
       coalesce(r.pushes, 0)                 as pushes,
       coalesce(r.commits, 0)                as commits,
       coalesce(r.prs_opened, 0)             as prs_opened,
       coalesce(r.prs_merged, 0)             as prs_merged,
       coalesce(r.reviews_given, 0)          as reviews_given,
       coalesce(r.review_comments, 0)        as review_comments,
       coalesce(r.cost_usd, 0)               as cost_usd
from people p
left join daily_rollup r on r.person_id = p.id and r.day = current_date
where p.active;

/**
 * Media de los 14 dias anteriores (sin contar hoy), a nivel de EQUIPO.
 *
 * Es la referencia contra la que comparar el dia en curso. Deliberadamente sin
 * desglose por persona: sirve para ver si hoy es un dia raro para el equipo, no
 * para comparar a nadie con su propia media.
 *
 * Solo cuenta dias con actividad: incluir fines de semana y festivos hundiria la
 * media y haria que cualquier lunes pareciera excepcional.
 */
create or replace view v_trailing_average as
with por_dia as (
  select day,
         sum(claude_seconds + codex_seconds_est) / 3600.0 as tool_hours,
         sum(pushes)     as pushes,
         sum(prs_merged) as merges
  from daily_rollup
  where day >= current_date - 14 and day < current_date
  group by day
  having sum(pushes) + sum(prs_merged) > 0
      or sum(claude_seconds + codex_seconds_est) > 0
)
select count(*)          as days_counted,
       avg(tool_hours)   as avg_tool_hours,
       avg(pushes)       as avg_pushes,
       avg(merges)       as avg_merges
from por_dia;
