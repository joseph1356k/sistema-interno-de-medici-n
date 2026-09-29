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
