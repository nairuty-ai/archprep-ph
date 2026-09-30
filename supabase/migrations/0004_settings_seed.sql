-- 0004_settings_seed.sql
-- Platform v2 settings: the key/value configuration table and its seeded rows.
--
-- Grants and RLS are deliberately NOT in this file. The revoke-first baseline is
-- migration 0005 and the display-safe allowlist policy
-- (settings_select_display_safe) is migration 0010. This file depends only on
-- the public schema, so it is independent of 0002 and 0003.
--
-- Requirements: 20.12, 24.1, 9.9

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
-- value is text for every key. Numeric and enumerated settings are cast at the
-- read site (fulfil_payment casts referral_amount to numeric and reward_type to
-- the reward_type enum), and per-key validation on save lives in the
-- admin-settings Edge Function. One column type keeps the admin editor and the
-- allowlist policy uniform across keys.
--
-- display_safe IS the Display_Safe_Keys allowlist from Requirement 9, expressed
-- as data rather than as a literal key list inside a policy. It defaults to
-- false, so a setting added later is private until someone deliberately marks
-- it readable: the safe direction to fail.

create table public.settings (
  key          text primary key,
  value        text not null,
  display_safe boolean not null default false,
  updated_at   timestamptz not null default now()
);

comment on table public.settings is
  'Admin-editable configuration. Client roles read only rows where display_safe = true, via settings_select_display_safe (migration 0010).';

comment on column public.settings.display_safe is
  'The Display_Safe_Keys allowlist as data. Default false: a new key is service-role only until explicitly published. answer_reveal_mode must stay false (Requirements 9.9, 6.13).';

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
-- Idempotent: on conflict do nothing, so re-running the migration set never
-- overwrites a value an admin has since edited through the Admin_Portal.
--
-- Requirement 24.1: referral_amount 9, reward_type cash, payout_threshold 100,
-- reward_on every_purchase. These four are display-safe because the front end
-- renders them - the referral amount on the product page, the threshold on the
-- Earnings view (Requirement 25 criteria 4 and 5).
--
-- Requirement 20.12 and 9.9: answer_reveal_mode is seeded answered_only with
-- display_safe = false. It governs how much of the answer key the grading
-- function returns, so no client role may read it; the Grade_Quiz_Function
-- reads it through the service role only.
--
-- The brand, contact, banner, and hero copy keys replace the BRAND_NAME,
-- CONTACT_EMAIL_FALLBACK, HERO_HEADLINE_FALLBACK, and HERO_SUBHEAD_FALLBACK
-- constants removed from config.js, so copy is editable without a deploy. All
-- display-safe: they are rendered to anonymous visitors by definition.
-- announcement_banner seeds empty, which the front end treats as "no banner".

insert into public.settings (key, value, display_safe) values
  ('referral_amount',     '9',                    true),
  ('reward_type',         'cash',                 true),
  ('payout_threshold',    '100',                  true),
  ('reward_on',           'every_purchase',       true),
  ('answer_reveal_mode',  'answered_only',        false),
  ('brand_name',          'ArchPrep PH',          true),
  ('contact_email',       'rehinaneel@gmail.com', true),
  ('announcement_banner', '',                     true),
  ('hero_headline',       'Pass the Architect Licensure Exam with confidence.', true),
  ('hero_subhead',        'Focused review materials and exam-style practice quizzes for Filipino architecture graduates.', true)
on conflict (key) do nothing;
