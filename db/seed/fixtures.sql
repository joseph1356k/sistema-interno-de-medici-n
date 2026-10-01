\set ON_ERROR_STOP on
-- Datos minimos pero realistas para ejercitar cada vista y funcion.

insert into people (id, display_name, git_emails, github_login) values
  ('11111111-1111-1111-1111-111111111111','Ana',  array['ana@e.com'],  'ana'),
  ('22222222-2222-2222-2222-222222222222','Luis', array['luis@e.com'], 'luis');

insert into devices (hostname, person_id, os) values
  ('pc-01','11111111-1111-1111-1111-111111111111','Windows 11'),
  ('pc-02','22222222-2222-2222-2222-222222222222','Windows 11'),
  ('pc-99', null, 'Windows 11');

insert into tool_metrics (hostname, tool, service_name, metric, value, unit, attrs, observed_at) values
  ('pc-01','claude_code','claude-code','claude_code.active_time.total',1800,'s','{"type":"user"}','2026-09-20T10:00:00Z'),
  ('pc-01','claude_code','claude-code','claude_code.active_time.total',900,'s','{"type":"cli"}','2026-09-20T10:00:00Z'),
  ('pc-01','claude_code','claude-code','claude_code.cost.usage',3.5,'USD','{}','2026-09-20T10:00:00Z'),
  ('pc-01','claude_code','claude-code','claude_code.token.usage',120000,'','{}','2026-09-20T10:00:00Z'),
  ('pc-01','claude_code','claude-code','claude_code.code_edit_tool.decision',8,'','{"decision":"accept"}','2026-09-20T10:00:00Z'),
  ('pc-01','claude_code','claude-code','claude_code.code_edit_tool.decision',2,'','{"decision":"reject"}','2026-09-20T10:00:00Z'),
  ('pc-01','claude_code','claude-code','claude_code.lines_of_code.count',240,'','{"type":"added"}','2026-09-20T10:00:00Z'),
  ('pc-02','claude_code','claude-code','claude_code.active_time.total',600,'s','{"type":"user"}','2026-09-20T11:00:00Z');

insert into tool_events (hostname, tool, event_name, session_id, attrs, occurred_at) values
  ('pc-02','codex','codex.conversation_starts','c1','{}','2026-09-20T09:00:00Z'),
  ('pc-02','codex','codex.api_request','c1','{}','2026-09-20T09:02:00Z'),
  ('pc-02','codex','codex.api_request','c1','{}','2026-09-20T09:05:00Z'),
  ('pc-02','codex','codex.api_request','c1','{}','2026-09-20T09:40:00Z');

insert into git_events (dedup_key, kind, repo, actor_login, author_email, ref, commit_count, occurred_at) values
  ('g1','push','e/app','compartida','ana@e.com','refs/heads/main',3,'2026-09-20T12:00:00Z'),
  ('g2','push','e/app','compartida','ana@e.com','refs/heads/main',1,'2026-09-20T15:00:00Z'),
  ('g3','push','e/app','compartida','desconocido@x.com','refs/heads/main',1,'2026-09-21T09:00:00Z');

insert into pull_requests (repo, number, author_login, state, head_sha, base_ref,
  additions, deletions, changed_files, commits, mergeable_state, requested_reviewers,
  last_review_state, created_at, first_review_at, approved_at, merged_at, event_ts) values
  ('e/app',1,'ana','merged','sha1','main',120,30,4,3,'clean',0,'approved',
   '2026-09-15T09:00:00Z','2026-09-15T14:00:00Z','2026-09-16T09:00:00Z','2026-09-16T11:00:00Z','2026-09-16T11:00:00Z'),
  ('e/app',2,'luis','merged','sha2','main',800,200,25,9,'clean',0,'approved',
   '2026-09-17T09:00:00Z','2026-09-19T09:00:00Z','2026-09-19T15:00:00Z','2026-09-19T16:00:00Z','2026-09-19T16:00:00Z'),
  ('e/app',3,'ana','open','sha3','main',40,5,2,1,'unstable',1,null,
   '2026-09-24T09:00:00Z',null,null,null,'2026-09-24T09:00:00Z'),
  ('e/app',4,'luis','closed','sha4','main',10,10,1,1,'dirty',0,null,
   '2026-09-22T09:00:00Z',null,null,null,'2026-09-23T09:00:00Z');
update pull_requests set closed_at='2026-09-23T09:00:00Z' where number=4;

insert into ci_runs (dedup_key, repo, head_sha, provider, name, branch, status, conclusion,
  attempt, started_at, completed_at, duration_seconds) values
  ('c1','e/app','sha1','check_suite','CI','main','completed','success',1,'2026-09-16T10:00:00Z','2026-09-16T10:08:00Z',480),
  ('c2','e/app','sha3','check_suite','CI','feature','completed','failure',1,'2026-09-24T10:00:00Z','2026-09-24T10:05:00Z',300),
  ('c3','e/app','sha3','check_suite','CI','feature','completed','failure',2,'2026-09-24T10:30:00Z','2026-09-24T10:35:00Z',300),
  ('c3b','e/app','sha3','check_suite','CI','feature','completed','success',3,'2026-09-24T11:00:00Z','2026-09-24T11:06:00Z',360),
  -- Un solo fallo seguido de exito: relanzar tras un corte de red es lo normal y
  -- NO debe contar como test inestable.
  ('c6','e/app','sha5','check_suite','CI','feature','completed','failure',1,'2026-09-24T14:00:00Z','2026-09-24T14:03:00Z',180),
  ('c7','e/app','sha5','check_suite','CI','feature','completed','success',2,'2026-09-24T14:30:00Z','2026-09-24T14:36:00Z',360),
  ('c4','e/app','sha9','check_suite','CI','main','completed','failure',1,'2026-09-25T08:00:00Z','2026-09-25T08:04:00Z',240),
  ('c5','e/app','sha10','check_suite','CI','main','completed','success',1,'2026-09-25T12:00:00Z','2026-09-25T12:05:00Z',300);

insert into reviews (dedup_key, repo, pr_number, reviewer_login, pr_author_login, state, submitted_at, external_id) values
  ('r1','e/app',1,'luis','ana','approved','2026-09-15T14:00:00Z','rev1'),
  ('r2','e/app',2,'ana','luis','changes_requested','2026-09-19T09:00:00Z','rev2'),
  ('r3','e/app',2,'ana','luis','approved','2026-09-19T15:00:00Z','rev3');

insert into review_comments (dedup_key, repo, pr_number, review_id, commenter_login, created_at) values
  ('rc1','e/app',2,'rev2','ana','2026-09-19T09:01:00Z'),
  ('rc2','e/app',2,'rev2','ana','2026-09-19T09:02:00Z');

insert into deployments (dedup_key, repo, environment, ref, sha, source, deployed_at, is_rollback) values
  ('d1','e/app','production','main','sha1','release','2026-09-16T12:00:00Z',false),
  ('d2','e/app','production','main','sha2','release','2026-09-19T18:00:00Z',false),
  ('d3','e/app','production','main','sha2','release','2026-09-19T20:00:00Z',true);

insert into commit_files (dedup_key, repo, sha, path_hash, change_type, committed_at) values
  ('f1','e/app','sha1','h_a','modified','2026-09-16T09:00:00Z'),
  ('f2','e/app','sha1','h_b','added','2026-09-16T09:00:00Z'),
  ('f3','e/app','sha2','h_a','modified','2026-09-18T09:00:00Z');

-- ---------------------------------------------------------------------------
-- Casos de calidad de datos (repo e/q, PRs 501+), para las aserciones de 0008
-- ---------------------------------------------------------------------------

-- Persona y equipo aislados para la prueba de zona horaria.
insert into people (id, display_name, git_emails, github_login) values
  ('33333333-3333-3333-3333-333333333333','Zoe', array['zoe@e.com'], 'zoe');
insert into devices (hostname, person_id, os) values
  ('pc-tz','33333333-3333-3333-3333-333333333333','Windows 11');

-- 02:30 UTC del 22 = 21:30 del 21 en Bogota (UTC-5). Cae en un dia u otro segun
-- la zona del equipo, que es justo lo que se prueba.
insert into tool_metrics (hostname, tool, metric, value, unit, attrs, observed_at) values
  ('pc-tz','claude_code','claude_code.active_time.total',600,'s','{"type":"user"}','2026-09-22T02:30:00Z');

-- Tokens: las lecturas de cache no deben contar.
insert into tool_metrics (hostname, tool, metric, value, unit, attrs, observed_at) values
  ('pc-01','claude_code','claude_code.token.usage',1000,'','{"type":"input"}','2026-09-21T15:00:00Z'),
  ('pc-01','claude_code','claude_code.token.usage',500,'','{"type":"output"}','2026-09-21T15:00:00Z'),
  ('pc-01','claude_code','claude_code.token.usage',900000,'','{"type":"cacheRead"}','2026-09-21T15:00:00Z');

insert into pull_requests (repo, number, author_login, state, head_sha, head_ref,
  additions, deletions, changed_files, created_at, ready_at, first_review_at,
  approved_at, merged_at, event_ts) values
  -- 501: de un bot. No debe entrar en ninguna metrica de ciclo.
  ('e/q',501,'dependabot[bot]','merged','q501','dependabot/npm/x', 3,3,1,
   '2026-09-22T09:00:00Z','2026-09-22T09:00:00Z',null,null,'2026-09-22T09:05:00Z','2026-09-22T09:05:00Z'),
  -- 502: revisado MIENTRAS era borrador. Antes daba horas negativas.
  ('e/q',502,'luis','merged','q502','feature', 40,10,2,
   '2026-09-22T09:00:00Z','2026-09-22T12:00:00Z','2026-09-22T10:00:00Z',
   '2026-09-22T13:00:00Z','2026-09-22T14:00:00Z','2026-09-22T14:00:00Z'),
  -- 503: reversion mergeada (rama creada por el boton Revert de GitHub).
  ('e/q',503,'ana','merged','q503','revert-502-feature', 3,3,1,
   '2026-09-23T09:00:00Z','2026-09-23T09:00:00Z',null,null,'2026-09-23T10:00:00Z','2026-09-23T10:00:00Z'),
  -- 504: mergeado sin que nadie lo revisara.
  ('e/q',504,'ana','merged','q504','hotfix', 2,1,1,
   '2026-09-23T09:00:00Z','2026-09-23T09:00:00Z',null,null,'2026-09-23T09:30:00Z','2026-09-23T09:30:00Z');

insert into reviews (dedup_key, repo, pr_number, reviewer_login, pr_author_login, state, submitted_at, external_id) values
  -- Revision real de 502.
  ('q-r1','e/q',502,'ana','luis','approved','2026-09-22T13:00:00Z','q-rev-1'),
  -- Autorrevision: Luis comentando su propio PR. No es la revision que se espera.
  ('q-r2','e/q',502,'luis','luis','commented','2026-09-22T09:30:00Z','q-rev-2'),
  -- Un bot que revisa a los segundos.
  ('q-r3','e/q',502,'coderabbit[bot]','luis','commented','2026-09-22T09:01:00Z','q-rev-3');

insert into deployments (dedup_key, repo, environment, ref, sha, source, deployed_at, status, is_rollback) values
  -- Preview de Vercel: no es un despliegue a produccion.
  ('q-d0','e/q','Preview – web','feature','q1','deployment_status','2026-09-22T10:00:00Z','success',false),
  ('q-d1','e/q','Production – web','main','q1','deployment_status','2026-09-22T11:00:00Z','success',false),
  ('q-d2','e/q','Production – web','main','q2','deployment_status','2026-09-22T15:00:00Z','success',false),
  -- Volver a desplegar q1 despues de q2: una reversion.
  ('q-d3','e/q','Production – web','main','q1','deployment_status','2026-09-22T16:00:00Z','success',false),
  -- Despliegue fallido.
  ('q-d4','e/q','Production – web','main','q3','deployment_status','2026-09-23T11:00:00Z','failure',false);
