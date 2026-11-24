-- 0023_setting_login_email_code.sql
-- Whether the login email shows a 6-digit code. Free-plan Supabase sends
-- only a login link until custom SMTP unlocks the email template; while this
-- is 'off' the login page asks the student to click the link and hides the
-- code boxes. Set to 'on' once the template includes {{ .Token }}.

insert into public.settings (key, value, display_safe)
values ('login_email_code', 'off', true)
on conflict (key) do nothing;
