-- 0014_v2_catalog.sql
-- v2 catalog (BACKEND_RULES.md §1, §8):
--   products  type material|quiz|mock|free, subject A|B|ALL, status
--             draft|published|unpublished, access rule per product
--   quizzes   time limit in seconds, status
--   questions versioned (lineage_id + version), topic, subject, status,
--             options as a plain text array and correct_index
-- Existing rows are transformed, not dropped.

-- The catalog policies read the columns replaced below; 0018 recreates them.
drop policy if exists products_select_published     on public.products;
drop policy if exists quizzes_select_published      on public.quizzes;
drop policy if exists pack_quizzes_select_published on public.pack_quizzes;

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
alter table public.products
  alter column type type text
  using (case type::text when 'quiz_pack' then 'quiz' else type::text end);
drop type public.product_type;
alter table public.products
  add constraint products_type_check check (type in ('material','quiz','mock','free'));

update public.products set subject = case
  when upper(coalesce(subject, '')) ~ '(^|[^A-Z])B$' then 'B'
  when upper(coalesce(subject, '')) ~ '(^|[^A-Z])A$' then 'A'
  else 'ALL' end;
alter table public.products
  alter column subject set default 'ALL',
  alter column subject set not null,
  add constraint products_subject_check check (subject in ('A','B','ALL'));

alter table public.products drop constraint products_price_php_check;
alter table public.products
  add constraint products_price_php_check
  check (price_php >= 0 and (type = 'free') = (price_php = 0));

alter table public.products
  add column status text not null default 'draft'
    check (status in ('draft','published','unpublished')),
  add column access_mode text,
  add column attempts_per_purchase integer
    check (attempts_per_purchase is null or attempts_per_purchase > 0),
  add column material_pages integer not null default 0 check (material_pages >= 0),
  add column updated_at timestamptz not null default now();

update public.products set
  status = case when published then 'published' else 'draft' end,
  access_mode = case type when 'material' then 'exam_date'
                          when 'free'     then 'unlimited'
                          else 'attempts' end,
  attempts_per_purchase = case when type in ('quiz','mock')
                               then public.setting_int('quiz_attempts', 2) end;

alter table public.products drop column published;
alter table public.products
  alter column access_mode set not null,
  add constraint products_access_mode_check
    check (access_mode in ('exam_date','attempts','unlimited')),
  add constraint products_attempts_match_check
    check ((access_mode = 'attempts') = (attempts_per_purchase is not null));

create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- quizzes
-- ---------------------------------------------------------------------------
alter table public.quizzes
  add column time_limit_sec integer not null default 0 check (time_limit_sec >= 0),
  add column status text not null default 'draft'
    check (status in ('draft','published','archived'));

update public.quizzes set
  time_limit_sec = timer_minutes * 60,
  status = case when published then 'published' else 'draft' end,
  subject = case
    when upper(coalesce(subject, '')) ~ '(^|[^A-Z])B$' then 'B'
    when upper(coalesce(subject, '')) ~ '(^|[^A-Z])A$' then 'A'
    else 'ALL' end;

alter table public.quizzes drop column timer_minutes, drop column published;
alter table public.quizzes
  alter column subject set default 'ALL',
  alter column subject set not null,
  add constraint quizzes_subject_check check (subject in ('A','B','ALL'));

-- ---------------------------------------------------------------------------
-- questions: editing creates a new version (same lineage_id, version + 1);
-- the old row is archived, and attempts keep pointing at the row they used.
-- ---------------------------------------------------------------------------
alter table public.questions
  add column lineage_id    uuid not null default gen_random_uuid(),
  add column version       integer not null default 1 check (version > 0),
  add column topic         text,
  add column subject       text check (subject in ('A','B')),
  add column status        text not null default 'published'
    check (status in ('draft','published','archived')),
  add column correct_index integer;

-- options were [{key, text}] with correct_key naming one key; both SET
-- expressions read the old row, so the index is taken before options flatten.
update public.questions q set
  correct_index = (select o.ord - 1
                     from jsonb_array_elements(q.options) with ordinality o(elem, ord)
                    where jsonb_typeof(o.elem) = 'object'
                      and o.elem->>'key' = q.correct_key
                    limit 1),
  options = (select coalesce(jsonb_agg(
                      case when jsonb_typeof(o.elem) = 'object' then to_jsonb(o.elem->>'text')
                           else o.elem end
                      order by o.ord), '[]'::jsonb)
               from jsonb_array_elements(q.options) with ordinality o(elem, ord))
 where jsonb_typeof(q.options) = 'array';

update public.questions
   set correct_index = ascii(upper(correct_key)) - 65
 where correct_index is null and correct_key ~ '^[A-Za-z]$';

update public.questions set options = '[]'::jsonb where jsonb_typeof(options) <> 'array';
update public.questions
   set correct_index = null, status = 'draft'
 where correct_index is null or correct_index >= jsonb_array_length(options);

update public.questions q set subject = z.subject
  from public.quizzes z
 where z.id = q.quiz_id and z.subject in ('A','B');

alter table public.questions drop column correct_key;
alter table public.questions
  drop constraint questions_quiz_id_question_number_key,
  add constraint questions_options_array_check check (jsonb_typeof(options) = 'array'),
  add constraint questions_correct_index_check
    check (correct_index is null
           or (correct_index >= 0 and correct_index < jsonb_array_length(options))),
  add constraint questions_published_needs_key_check
    check (status <> 'published' or correct_index is not null),
  add constraint questions_lineage_version_key unique (lineage_id, version);

create unique index questions_live_number_key
  on public.questions (quiz_id, question_number) where status <> 'archived';
