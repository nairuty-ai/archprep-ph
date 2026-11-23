-- v1_fixture.sql: v1-shaped rows used to test that 0013+ transforms existing
-- data. Run after 0001-0012 and before 0013 on a throwaway database only.
insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'referrer@test.ph', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'buyer@test.ph',    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
update public.profiles set display_name = 'Referrer', gcash_number = '+63 917 482 6610', ref_code = 'REFAAAA1'
 where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set display_name = 'Buyer', referred_by = 'REFAAAA1'
 where id = '00000000-0000-0000-0000-0000000000b1';

insert into public.products (id, slug, type, subject, title, price_php, published) values
  ('00000000-0000-0000-0000-00000000c001', 'subject-a-reviewer', 'material',  'Subject A', 'Subject A Reviewer', 49, true),
  ('00000000-0000-0000-0000-00000000c002', 'subject-b-quiz',     'quiz_pack', 'B',         'Subject B Quiz Pack', 19, true);
insert into public.quizzes (id, slug, title, subject, timer_minutes, published) values
  ('00000000-0000-0000-0000-00000000d001', 'quiz-b', 'Subject B Quiz', 'Subject B', 30, true);
insert into public.pack_quizzes (product_id, quiz_id) values
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000d001');
insert into public.questions (quiz_id, question_number, question_text, options, correct_key, explanation) values
  ('00000000-0000-0000-0000-00000000d001', 1, 'Dead load is?',
   '[{"key":"A","text":"Live"},{"key":"B","text":"Permanent"},{"key":"C","text":"Wind"},{"key":"D","text":"Seismic"}]', 'B', 'x'),
  ('00000000-0000-0000-0000-00000000d001', 2, 'RA 9266 is?',
   '[{"key":"A","text":"Building code"},{"key":"B","text":"Architecture Act"}]', 'B', 'y');

insert into public.orders (id, user_id, product_id, amount_php, status, hitpay_payment_id, ref_code, paid_at) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-00000000c002', 19.00, 'paid', 'hp_1', 'REFAAAA1', now());
insert into public.enrollments (user_id, product_id, source, order_id) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000c002', 'purchase',
   '00000000-0000-0000-0000-00000000e001');
insert into public.referrals (referrer_ref_code, referrer_user_id, buyer_user_id, buyer_masked, order_id,
                              product_id, product_title, amount_php, reward_type, status) values
  ('REFAAAA1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'b***@test.ph',
   '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000c002', 'Subject B Quiz Pack', 9, 'cash', 'available');
insert into public.quiz_attempts (user_id, quiz_id, score, total, answers) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000d001', 1, 2, '{"1":"B"}');
