-- 0024_job_interests.sql
-- "Work with us": people leave an email (required) and optionally a name,
-- area, note and résumé to be told when a role opens. Written only by the
-- careers-interest Edge Function (service role); no client can read or write.

create table public.job_interests (
  id          uuid primary key default gen_random_uuid(),
  email       text not null
              check (email = lower(btrim(email)) and char_length(email) <= 254
                     and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  name        text check (char_length(name) <= 100),
  area        text check (area in ('question_writer','reviewer_writer','faculty','support','other')),
  message     text check (char_length(message) <= 2000),
  resume_path text,
  consent_at  timestamptz not null default now(),
  ip          text,
  notified_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- One entry per email; submitting again updates it.
create unique index job_interests_email_key on public.job_interests (email);
create index job_interests_ip_idx on public.job_interests (ip, updated_at desc);

alter table public.job_interests enable row level security;
alter table public.job_interests force row level security;

-- Max 5 submissions per IP per hour. Returns the row id so the Edge Function
-- can attach the résumé it uploads under that id.
create or replace function public.job_interest_submit(
  p_email text, p_name text, p_area text, p_message text, p_ip text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id    uuid;
  v_new   boolean;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 254 then
    raise exception 'EMAIL_INVALID';
  end if;
  if p_ip is not null
     and (select count(*) from public.job_interests
           where ip = p_ip and updated_at > now() - interval '1 hour') >= 5 then
    raise exception 'RATE_LIMITED';
  end if;

  insert into public.job_interests (email, name, area, message, ip)
  values (v_email, nullif(left(btrim(coalesce(p_name, '')), 100), ''),
          nullif(p_area, ''), nullif(left(btrim(coalesce(p_message, '')), 2000), ''), p_ip)
  on conflict (email) do update
     set name = coalesce(excluded.name, job_interests.name),
         area = coalesce(excluded.area, job_interests.area),
         message = coalesce(excluded.message, job_interests.message),
         ip = excluded.ip, consent_at = now(), updated_at = now()
  returning id, (xmax = 0) into v_id, v_new;

  return jsonb_build_object('id', v_id, 'new', v_new);
end $$;

create or replace function public.job_interest_attach_resume(p_id uuid, p_path text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.job_interests set resume_path = p_path, updated_at = now() where id = p_id;
$$;

revoke execute on function public.job_interest_submit(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.job_interest_attach_resume(uuid, text) from public, anon, authenticated;

-- Private bucket for résumés, 5 MB, PDF/DOC/DOCX (the Edge Function checks
-- the same). Created only where a current Supabase Storage schema exists;
-- bare or stub Postgres images used in tests skip it.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    execute $i$
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('resumes', 'resumes', false, 5242880,
              array['application/pdf', 'application/msword',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
      on conflict (id) do nothing$i$;
  end if;
end $$;
