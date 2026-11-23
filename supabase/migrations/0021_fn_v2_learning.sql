-- 0021_fn_v2_learning.sql
-- Exams (BACKEND_RULES.md §8): starting an attempt uses it, answers autosave
-- until ends_at, submit grades on the server and is idempotent, a job
-- auto-submits attempts past ends_at. Plus the public leaderboard.

-- Result shape shared by submit_attempt and its idempotent replay.
-- Passing: >= 70% overall and no subject below 50%.
create or replace function public.attempt_result(p_attempt public.attempts) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'attempt_id', p_attempt.id,
    'quiz_id', p_attempt.quiz_id,
    'attempt_no', p_attempt.attempt_no,
    'score', p_attempt.score,
    'total', p_attempt.total,
    'pct', case when p_attempt.total > 0
                then round(p_attempt.score * 100.0 / p_attempt.total)::integer else 0 end,
    'breakdown', coalesce(p_attempt.breakdown, '{}'::jsonb),
    'passed', p_attempt.total > 0
              and p_attempt.score * 100.0 / p_attempt.total >= 70
              and not exists (
                select 1 from jsonb_each(coalesce(p_attempt.breakdown, '{}'::jsonb)) b
                 where (b.value->>'total')::integer > 0
                   and (b.value->>'correct')::numeric * 100 / (b.value->>'total')::numeric < 50),
    'submitted_at', p_attempt.submitted_at,
    'auto_submitted', p_attempt.auto_submitted);
$$;

-- p_uid null = the system (auto-submit job).
create or replace function public.submit_attempt(
  p_attempt_id uuid, p_uid uuid, p_auto boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a         public.attempts;
  v_e         public.enrollments;
  v_score     integer;
  v_total     integer;
  v_breakdown jsonb;
  v_result    jsonb;
begin
  select * into v_a from public.attempts where id = p_attempt_id for update;
  if not found or (p_uid is not null and v_a.user_id <> p_uid) then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if v_a.status = 'submitted' then
    return public.attempt_result(v_a);
  end if;

  -- Unanswered items count as wrong. Subject per question, falling back to
  -- the quiz subject.
  with q as (
    select u.qid, qs.correct_index,
           coalesce(qs.subject, case when z.subject in ('A','B') then z.subject end, 'ALL') as subj
      from unnest(v_a.question_ids) as u(qid)
      join public.questions qs on qs.id = u.qid
      join public.quizzes z on z.id = qs.quiz_id),
  g as (
    select q.subj, (aa.choice is not null and aa.choice = q.correct_index) as ok
      from q left join public.attempt_answers aa
        on aa.attempt_id = v_a.id and aa.question_id = q.qid),
  s as (
    select subj, count(*) filter (where ok) as c, count(*) as t from g group by subj)
  select coalesce(sum(c), 0)::integer, coalesce(sum(t), 0)::integer,
         coalesce(jsonb_object_agg(subj, jsonb_build_object('correct', c, 'total', t)), '{}'::jsonb)
    into v_score, v_total, v_breakdown
    from s;

  update public.attempts
     set status = 'submitted', submitted_at = now(), auto_submitted = coalesce(p_auto, false),
         score = v_score, total = v_total, breakdown = v_breakdown
   where id = v_a.id
  returning * into v_a;

  v_result := public.attempt_result(v_a);

  if v_a.enrollment_id is not null then
    select * into v_e from public.enrollments where id = v_a.enrollment_id;
    if v_e.attempts_allowed is not null and v_e.attempts_allowed - v_e.attempts_used = 1 then
      perform public.enqueue_email('E10',
        (select email from public.profiles where id = v_a.user_id),
        jsonb_build_object('name', (select display_name from public.profiles where id = v_a.user_id),
                           'quiz', (select title from public.quizzes where id = v_a.quiz_id),
                           'pct', v_result->'pct', 'breakdown', v_breakdown,
                           'attempts_left', 1, 'attempts_allowed', v_e.attempts_allowed),
        'E10:' || v_e.id);
    end if;
  end if;

  return v_result;
end $$;

create or replace function public.start_attempt(p_uid uuid, p_quiz_id uuid) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quiz    public.quizzes;
  v_open    public.attempts;
  v_e       public.enrollments;
  v_free    boolean;
  v_ids     uuid[];
  v_no      integer;
  v_attempt public.attempts;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id and status = 'published';
  if not found then
    raise exception 'QUIZ_NOT_FOUND';
  end if;
  if not exists (select 1 from public.profiles where id = p_uid and signup_completed_at is not null) then
    raise exception 'SIGNUP_INCOMPLETE';
  end if;

  select * into v_open from public.attempts
   where user_id = p_uid and status = 'in_progress' for update;
  if found then
    if v_open.ends_at is not null and v_open.ends_at <= now() then
      perform public.submit_attempt(v_open.id, null, true);
    elsif v_open.quiz_id = p_quiz_id then
      return jsonb_build_object(
        'attempt_id', v_open.id, 'quiz_id', v_open.quiz_id, 'attempt_no', v_open.attempt_no,
        'started_at', v_open.started_at, 'ends_at', v_open.ends_at, 'server_now', now(),
        'question_ids', to_jsonb(v_open.question_ids), 'resumed', true);
    else
      raise exception 'ATTEMPT_IN_PROGRESS';
    end if;
  end if;

  v_free := exists (
    select 1 from public.pack_quizzes pq join public.products p on p.id = pq.product_id
     where pq.quiz_id = p_quiz_id and p.type = 'free' and p.status = 'published');

  if not v_free then
    update public.enrollments e set status = 'ended', ended_at = now()
     where e.user_id = p_uid and e.status = 'active'
       and e.expires_at is not null and e.expires_at <= now()
       and e.product_id in (select product_id from public.pack_quizzes where quiz_id = p_quiz_id);

    select e.* into v_e
      from public.enrollments e
      join public.pack_quizzes pq on pq.product_id = e.product_id
     where pq.quiz_id = p_quiz_id and e.user_id = p_uid and e.status = 'active'
       and (e.attempts_allowed is null or e.attempts_used < e.attempts_allowed)
     order by e.created_at
     limit 1
     for update of e;
    if not found then
      if exists (select 1 from public.enrollments e
                   join public.pack_quizzes pq on pq.product_id = e.product_id
                  where pq.quiz_id = p_quiz_id and e.user_id = p_uid
                    and e.attempts_allowed is not null and e.attempts_used >= e.attempts_allowed) then
        raise exception 'ATTEMPTS_USED';
      end if;
      raise exception 'NO_ACCESS';
    end if;

    -- Starting uses the attempt; the last one ends the enrollment now, while
    -- the attempt itself stays open until submitted.
    update public.enrollments
       set attempts_used = attempts_used + 1,
           status   = case when attempts_allowed is not null and attempts_used + 1 >= attempts_allowed
                           then 'ended' else status end,
           ended_at = case when attempts_allowed is not null and attempts_used + 1 >= attempts_allowed
                           then now() else ended_at end
     where id = v_e.id
    returning * into v_e;
  end if;

  select coalesce(array_agg(id order by question_number), '{}') into v_ids
    from public.questions where quiz_id = p_quiz_id and status = 'published';
  if cardinality(v_ids) = 0 then
    raise exception 'QUIZ_EMPTY';
  end if;

  select count(*) + 1 into v_no from public.attempts where user_id = p_uid and quiz_id = p_quiz_id;

  insert into public.attempts (user_id, quiz_id, enrollment_id, attempt_no, question_ids, ends_at)
  values (p_uid, p_quiz_id, v_e.id, v_no, v_ids,
          case when v_quiz.time_limit_sec > 0
               then now() + v_quiz.time_limit_sec * interval '1 second' end)
  returning * into v_attempt;

  return jsonb_build_object(
    'attempt_id', v_attempt.id, 'quiz_id', p_quiz_id, 'attempt_no', v_attempt.attempt_no,
    'started_at', v_attempt.started_at, 'ends_at', v_attempt.ends_at, 'server_now', now(),
    'question_ids', to_jsonb(v_ids), 'resumed', false,
    'attempts_allowed', v_e.attempts_allowed, 'attempts_used', v_e.attempts_used);
end $$;

-- Batch autosave, used for every change and for the offline queue sync:
-- p_answers = [{question_id, choice (int|null), flagged (bool)}].
-- Rejected once ends_at has passed (5s grace for the request in flight).
create or replace function public.save_answers(
  p_uid uuid, p_attempt_id uuid, p_answers jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.attempts;
  v_n integer;
begin
  select * into v_a from public.attempts
   where id = p_attempt_id and user_id = p_uid for share;
  if not found then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if v_a.status <> 'in_progress'
     or (v_a.ends_at is not null and now() > v_a.ends_at + interval '5 seconds') then
    raise exception 'ATTEMPT_CLOSED';
  end if;
  if jsonb_typeof(p_answers) <> 'array' then
    raise exception 'ANSWERS_INVALID';
  end if;

  insert into public.attempt_answers (attempt_id, question_id, choice, flagged, updated_at)
  select p_attempt_id, (x->>'question_id')::uuid,
         case when jsonb_typeof(x->'choice') = 'number' then (x->>'choice')::integer end,
         coalesce((x->>'flagged')::boolean, false), now()
    from jsonb_array_elements(p_answers) x
   where (x->>'question_id')::uuid = any (v_a.question_ids)
  on conflict (attempt_id, question_id) do update
     set choice = excluded.choice, flagged = excluded.flagged, updated_at = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('saved', v_n, 'saved_at', now());
end $$;

-- Job (every minute): submit attempts whose timer ran out.
create or replace function public.auto_submit_due() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_n  integer := 0;
begin
  for v_id in
    select id from public.attempts
     where status = 'in_progress' and ends_at is not null and ends_at < now()
     for update skip locked
  loop
    perform public.submit_attempt(v_id, null, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Public leaderboard (§8): best submitted attempt per user, display name
-- only, for students who accepted the public_leaderboard consent. The
-- caller's own row is always included so "your rank" can be shown.
create or replace function public.leaderboard(p_quiz_id uuid, p_limit integer default 10)
returns table (rank bigint, display_name text, pct integer, is_me boolean, entrants bigint)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  with best as (
    select distinct on (a.user_id)
           a.user_id, a.score::numeric / a.total as ratio,
           round(a.score * 100.0 / a.total)::integer as pct
      from public.attempts a
     where a.quiz_id = p_quiz_id and a.status = 'submitted' and a.total > 0
       and exists (select 1 from public.consents c
                    where c.user_id = a.user_id and c.type = 'public_leaderboard')
     order by a.user_id, a.score::numeric / a.total desc, a.submitted_at
  ),
  ranked as (
    select b.*, rank() over (order by b.ratio desc) as r, count(*) over () as n from best b
  )
  select r.r, coalesce(nullif(btrim(p.display_name), ''), 'Reviewee'), r.pct,
         r.user_id = auth.uid(), r.n
    from ranked r join public.profiles p on p.id = r.user_id
   where coalesce((select value from public.settings where key = 'leaderboard_mode'), 'public') <> 'off'
     and (r.r <= least(greatest(coalesce(p_limit, 10), 1), 50) or r.user_id = auth.uid())
   order by r.r, 2;
$$;
