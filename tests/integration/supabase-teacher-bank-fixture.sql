-- Include inside a disposable test transaction; never apply as a migration.
INSERT INTO auth.users(id,email,raw_app_meta_data,is_anonymous,encrypted_password)
VALUES('30000000-0000-4000-8000-000000000001','fixture-guru@accounts.ular-tangga.invalid','{"provider":"email"}',false,'fixture');
INSERT INTO public.ular_teacher_roles(user_id) VALUES('30000000-0000-4000-8000-000000000001');
INSERT INTO public.ular_teacher_questions(id,owner_id,question)
VALUES('teacher-fixture-question','30000000-0000-4000-8000-000000000001','{"id":"teacher-fixture-question","question":"Isolated teacher question?","options":["Correct","Wrong","Other","None"],"answer":0,"explanation":"fixture only","category":"QA","difficulty":"mudah","timeLimit":30,"active":true}');
