-- Sistema interno de medicion -- esquema inicial
--
-- Principio de diseno: los nombres de las personas viven UNICAMENTE en la tabla
-- `people`. Todo lo que envian los PCs viaja identificado solo por hostname; todo
-- lo que envia GitHub viaja identificado por email de git o login. La resolucion a
-- una persona ocurre aqui, en el servidor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Identidad
-- ---------------------------------------------------------------------------

create table people (
  id            uuid primary key default gen_random_uuid(),
  display_name  text        not null,
  -- Emails de git (git config user.email). Permite atribuir commits y push
  -- aunque el push salga de una cuenta de GitHub compartida.
  git_emails    text[]      not null default '{}',
  -- Login de GitHub, cuando la persona tiene cuenta propia.
  github_login  text,
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

comment on table people is
  'Unica tabla que asocia datos de medicion con una persona identificable.';

create unique index people_github_login_key
  on people (lower(github_login)) where github_login is not null;

-- Un email de git no puede pertenecer a dos personas.
create index people_git_emails_idx on people using gin (git_emails);

-- Un PC = una persona. Es la clave de atribucion para la telemetria de
-- herramientas, porque las cuentas de Claude son compartidas.
create table devices (
  hostname    text        primary key,
  person_id   uuid        references people(id) on delete set null,
  os          text,
  notes       text,
  active      boolean     not null default true,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz
);

comment on column devices.person_id is
  'Null = equipo visto en telemetria pero aun sin asignar. Los datos se guardan '
  'igual y se resuelven cuando se registra el mapeo.';

-- ---------------------------------------------------------------------------
-- Telemetria de herramientas (Claude Code, Codex)
-- ---------------------------------------------------------------------------

create type tool_kind as enum ('claude_code', 'codex');

-- Muestras numericas (metricas OTel). La temporalidad de Claude Code es `delta`
-- por defecto, asi que `value` es el incremento del intervalo, no un acumulado.
create table tool_metrics (
  id            bigserial   primary key,
  hostname      text        not null,
  tool          tool_kind   not null,
  service_name  text,
  metric        text        not null,
  value         double precision not null,
  unit          text,
  -- Solo claves de la allowlist (src/lib/allowlist.ts). Nunca contenido.
  attrs         jsonb       not null default '{}'::jsonb,
  observed_at   timestamptz not null,
  ingested_at   timestamptz not null default now()
);

create index tool_metrics_lookup_idx
  on tool_metrics (hostname, metric, observed_at desc);
-- Consultas por rango de dias. No se usa date_trunc en el indice: es STABLE, no
-- IMMUTABLE (depende de TimeZone), y Postgres lo rechaza. Un btree por dimension
-- y tiempo sirve igual para los rangos.
create index tool_metrics_day_idx on tool_metrics (tool, observed_at desc);

-- Eventos discretos (logs OTel), sin contenido: solo el hecho de que ocurrieron.
create table tool_events (
  id            bigserial   primary key,
  hostname      text        not null,
  tool          tool_kind   not null,
  service_name  text,
  event_name    text        not null,
  -- session.id de Claude Code / conversation.id de Codex. Permite derivar
  -- duracion de sesion en Codex, que no expone metrica de tiempo activo.
  session_id    text,
  attrs         jsonb       not null default '{}'::jsonb,
  occurred_at   timestamptz not null,
  ingested_at   timestamptz not null default now()
);

create index tool_events_session_idx
  on tool_events (tool, session_id, occurred_at);
create index tool_events_day_idx on tool_events (tool, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Actividad de git
-- ---------------------------------------------------------------------------

create type git_event_kind as enum (
  'push', 'force_push', 'pr_opened', 'pr_merged', 'pr_closed', 'review'
);

create table git_events (
  id             bigserial      primary key,
  -- Clave de deduplicacion. GitHub no reintenta entregas fallidas pero si
  -- permite reenvio manual durante 3 dias, asi que el mismo evento puede llegar
  -- dos veces. Es `not null` y sin expresiones a proposito, para que
  -- `on conflict (dedup_key)` funcione tal cual desde el cliente.
  dedup_key      text           not null unique,
  -- X-GitHub-Delivery de origen, solo informativo.
  delivery_id    text,
  kind           git_event_kind not null,
  repo           text           not null,
  -- Cuenta que dispara el evento. Con cuentas compartidas es la cuenta comun,
  -- por eso no basta para atribuir.
  actor_login    text,
  -- Email del autor de los commits, que viene del git local de cada maquina.
  -- Esta es la clave real de atribucion con cuentas compartidas.
  author_email   text,
  ref            text,
  commit_count   integer,
  pr_number      integer,
  pr_created_at  timestamptz,
  pr_merged_at   timestamptz,
  first_review_at timestamptz,
  additions      integer,
  deletions      integer,
  changed_files  integer,
  review_state   text,
  -- Metadatos no sensibles (before/after sha, forced, draft...). Nunca diffs
  -- ni mensajes de commit.
  meta           jsonb          not null default '{}'::jsonb,
  occurred_at    timestamptz    not null,
  ingested_at    timestamptz    not null default now()
);

create index git_events_day_idx on git_events (kind, occurred_at desc);
create index git_events_author_idx on git_events (author_email, occurred_at desc);
create index git_events_pr_idx on git_events (repo, pr_number);
