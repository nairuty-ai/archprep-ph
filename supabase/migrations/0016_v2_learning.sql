-- 0016_v2_learning.sql
-- v2 access and exams (BACKEND_RULES.md §2, §8):
--   enrollments  re-buyable: one ACTIVE enrollment per (user, product),
--                attempts allowed/used, expiry, status active|ended|revoked
--   attempts     server-timed attempts with a question snapshot
--   attempt_answers  autosaved answers and flags
-- quiz_attempts rows become submitted attempts (their answers are kept as
-- legacy_answers).

-- ---------------------------------------------------------------------------
-- enrollments
-- ---------------------------------------------------------------------------
alter table public.enrollments drop constraint enrollments_user_product_key;

alter table public.enrollments
  add column access_mode      text not null default 'unlimited'
    check (access_mode in ('exam_date','attempts','unlimited','fixed')),
  add column attempts_allowed integer check (attempts_allowed is null or attempts_allowed > 0),
  add column attempts_used    integer not null default 0 check (attempts_used >= 0),
  add column expires_at       timestamptz,
  add column status           text not null default 'active'
    check (status in ('active','ended','revoked')),
  add column ended_at         timestamptz,
  add column revoked_reason   text;

update public.enrollments e set
  access_mode      = p.access_mode,
  attempts_allowed = p.attempts_per_purchase,
  expires_at       = case when p.access_mode = 'exam_date' then public.exam_date_ts() end
  from public.products p
 where p.id = e.product_id;

alter table public.enrollments
  add constraint enrollments_attempts_check
    check (attempts_allowed is null or attempts_used <= attempts_allowed),
  add constraint enrollments_order_product_key unique (order_id, product_id);

create unique index enrollments_one_active_key
  on public.enrollments (user_id, product_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- attempts
-- ---------------------------------------------------------------------------
create table public.attempts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  quiz_id        uuid not null references public.quizzes(id) on delete cascade,
  enrollment_id  uuid references public.enrollments(id) on delete set null,
  attempt_no     integer not null default 1 check (attempt_no > 0),
  status         text not null default 'in_progress' check (status in ('in_progress','submitted')),
  question_ids   uuid[] not null default '{}',
  started_at     timestamptz not null default now(),
  ends_at        timestamptz,
  submitted_at   timestamptz,
  auto_submitted boolean not null default false,
  score          integer check (score >= 0),
  total          integer check (total >= 0),
  breakdown      jsonb,
  legacy_answers jsonb
);
create unique index attempts_one_open_key on public.attempts (user_id) where status = 'in_progress';
create index attempts_user_quiz_idx on public.attempts (user_id, quiz_id, started_at desc);
create index attempts_due_idx on public.attempts (ends_at) where status = 'in_progress';
create index attempts_board_idx on public.attempts (quiz_id) where status = 'submitted';

create table public.attempt_answers (
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  choice      integer check (choice is null or choice >= 0),
  flagged     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (attempt_id, question_id)
);

insert into public.attempts
  (user_id, quiz_id, status, started_at, submitted_at, score, total, legacy_answers)
select user_id, quiz_id, 'submitted', created_at, created_at, score, total, answers
  from public.quiz_attempts;

drop table public.quiz_attempts;
