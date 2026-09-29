-- Borra los datos de demostracion. Identificados por prefijos conocidos, asi que
-- no puede tocar datos reales.
\set ON_ERROR_STOP on

delete from commit_files    where repo like 'demo/%';
delete from review_comments where repo like 'demo/%';
delete from reviews         where repo like 'demo/%';
delete from ci_runs         where repo like 'demo/%';
delete from deployments     where repo like 'demo/%';
delete from pull_requests   where repo like 'demo/%';
delete from git_events      where repo like 'demo/%';
delete from tool_metrics    where hostname like 'demo-pc-%';
delete from tool_events     where hostname like 'demo-pc-%';
delete from daily_rollup    where person_id::text like 'dddddddd%';
delete from devices         where hostname like 'demo-pc-%';
delete from people          where id::text like 'dddddddd%';

drop table if exists demo_tmp_pr_full;
drop table if exists demo_tmp_pr_times;
drop table if exists demo_tmp_prs;
drop table if exists demo_tmp_usage;
drop table if exists demo_tmp_days;
drop table if exists demo_tmp_people;

drop function if exists demo_rand(text);
drop function if exists demo_between(text, double precision, double precision);

select 'datos de demostración borrados' as resultado;
