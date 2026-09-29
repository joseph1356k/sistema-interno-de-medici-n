-- Estado presente del trabajo: PRs, CI, revisiones y despliegues.
--
-- `git_events` (0001) guarda HECHOS historicos. Estas tablas guardan el ESTADO
-- ACTUAL, que es lo que necesita el tablero en vivo: "que PRs estan abiertos
-- ahora y que los bloquea" no se puede responder sumando eventos sueltos.
--
-- Regla de privacidad que atraviesa el archivo: solo METADATOS. Ni titulos de PR,
-- ni mensajes de commit, ni cuerpos de comentario, ni diffs. El panel enlaza a
-- GitHub para el contenido, que es donde ya vive y donde ya hay permisos.

-- ---------------------------------------------------------------------------
-- Pull requests: una fila por PR, con su estado presente
-- ---------------------------------------------------------------------------

create type pr_state as enum ('open', 'closed', 'merged');

create table pull_requests (
  repo            text     not null,
  number          integer  not null,
  author_login    text,
  state           pr_state not null,
  draft           boolean  not null default false,

  head_sha        text,
  base_ref        text,

  additions       integer,
  deletions       integer,
  changed_files   integer,
  commits         integer,

  -- `mergeable_state` de GitHub: clean, dirty (conflicto), blocked, behind,
  -- unstable (CI en rojo), draft. Es lo que permite agrupar por motivo de bloqueo.
  mergeable       boolean,
  mergeable_state text,

  requested_reviewers integer not null default 0,
  -- Veredicto de la ultima revision: approved, changes_requested, commented.
  last_review_state   text,

  -- Hitos del ciclo. El desglose es lo que dice DONDE esta el atasco, no solo
  -- que existe.
  created_at      timestamptz,
  ready_at        timestamptz,  -- cuando dejo de ser borrador
  first_review_at timestamptz,
  approved_at     timestamptz,
  merged_at       timestamptz,
  closed_at       timestamptz,

  -- Marca del evento que produjo este estado. Los webhooks llegan desordenados,
  -- asi que un evento mas viejo que el estado guardado no debe sobrescribirlo.
  event_ts        timestamptz not null,
  updated_at      timestamptz not null default now(),

  primary key (repo, number)
);

comment on column pull_requests.event_ts is
  'Guarda contra eventos fuera de orden: solo se aplica un evento cuyo timestamp '
  'sea >= al guardado. La logica de fusion vive en src/lib/pr-state.ts.';

-- El tablero en vivo consulta por estado; el indice lo cubre.
create index pull_requests_open_idx
  on pull_requests (repo, state) where state = 'open';
create index pull_requests_merged_idx
  on pull_requests (merged_at desc) where merged_at is not null;
create index pull_requests_head_sha_idx on pull_requests (head_sha);
create index pull_requests_author_idx on pull_requests (author_login);

-- ---------------------------------------------------------------------------
-- CI
-- ---------------------------------------------------------------------------

create table ci_runs (
  id               bigserial   primary key,
  dedup_key        text        not null unique,
  repo             text        not null,
  head_sha         text        not null,
  -- De donde viene: check_suite, workflow_run o status (commit status).
  provider         text        not null,
  external_id      text,
  -- Nombre del workflow. Es configuracion del repo, no contenido de nadie.
  name             text,
  branch           text,
  status           text,  -- queued | in_progress | completed
  -- success, failure, cancelled, timed_out, action_required, neutral, skipped, stale
  conclusion       text,
  attempt          integer,
  trigger_event    text,  -- push | pull_request | schedule...
  started_at       timestamptz,
  completed_at     timestamptz,
  duration_seconds integer,
  ingested_at      timestamptz not null default now()
);

-- "Esta verde esto ahora?" y "cuanto lleva main en rojo?" son consultas por sha
-- y por rama con el ultimo resultado primero.
create index ci_runs_sha_idx on ci_runs (head_sha, completed_at desc);
create index ci_runs_branch_idx on ci_runs (repo, branch, completed_at desc);
create index ci_runs_conclusion_idx
  on ci_runs (repo, conclusion, completed_at desc) where conclusion is not null;

-- ---------------------------------------------------------------------------
-- Revisiones: trabajo invisible que normalmente no se mide
-- ---------------------------------------------------------------------------

create table reviews (
  id             bigserial   primary key,
  dedup_key      text        not null unique,
  repo           text        not null,
  pr_number      integer     not null,
  reviewer_login text,
  -- El login del autor del PR se copia aqui para poder responder "quien revisa a
  -- quien" sin un join extra en cada consulta del panel.
  pr_author_login text,
  state          text,  -- approved | changes_requested | commented | dismissed
  submitted_at   timestamptz not null,
  external_id    text,
  ingested_at    timestamptz not null default now()
);

create index reviews_reviewer_idx on reviews (reviewer_login, submitted_at desc);
create index reviews_pr_idx on reviews (repo, pr_number, submitted_at);

-- Solo metadatos del comentario: quien y cuando. El cuerpo NO se guarda.
-- Sirve para medir profundidad de revision (comentarios por revision) y detectar
-- aprobaciones de sello, que son las que no llevan ningun comentario.
create table review_comments (
  id             bigserial   primary key,
  dedup_key      text        not null unique,
  repo           text        not null,
  pr_number      integer     not null,
  review_id      text,
  commenter_login text,
  created_at     timestamptz not null,
  ingested_at    timestamptz not null default now()
);

create index review_comments_pr_idx on review_comments (repo, pr_number);
create index review_comments_review_idx on review_comments (review_id);

-- ---------------------------------------------------------------------------
-- Despliegues: necesarios para DORA
-- ---------------------------------------------------------------------------

create table deployments (
  id           bigserial   primary key,
  dedup_key    text        not null unique,
  repo         text        not null,
  environment  text,
  ref          text,
  sha          text,
  -- release | workflow_run | deployment_status: de donde se dedujo el despliegue.
  source       text        not null,
  deployed_at  timestamptz not null,
  -- Marca de reversion o arreglo urgente, para la tasa de fallo del cambio.
  is_rollback  boolean     not null default false,
  external_id  text,
  ingested_at  timestamptz not null default now()
);

create index deployments_repo_idx on deployments (repo, deployed_at desc);
