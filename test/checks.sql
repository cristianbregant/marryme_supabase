-- Checks of the database rules: each block fails (and stops everything) if
-- a rule does not hold. Run by test/run.sh.
\set ON_ERROR_STOP on
\set QUIET on

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'anna@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bruno@example.com');

\echo '— weddings: start on the free plan'
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
set role authenticated;
do $$
declare w public.weddings;
begin
  insert into public.weddings (owner_id, partner1_name, partner2_name, wedding_date, plan, notifications, sections)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'Anna', 'Luca', '2027-06-12', 'full', '{"x": 1}',
          '{"participation": {"enabled": true, "ceremonyInfo": "<p>Church</p>", "lunchInfo": "<p>Villa</p>"},
            "rsvp": {"enabled": true, "text": "<p>Let us know</p>",
                     "contacts": [{"label": "Anna <b>", "phone": "333'' x"}]},
            "video": {"enabled": true}}')
  returning * into w;
  assert w.owner_id = 'aaaaaaaa-0000-0000-0000-000000000001', 'the owner is whoever creates it';
  assert w.plan = 'free', 'the plan cannot be chosen';
  assert w.notifications = '{}', 'notifications belong to the server';
  assert not public.section_enabled(w.sections, 'video'), 'video off on the free plan';
  assert public.section_enabled(w.sections, 'rsvp'), 'rsvp included';
  perform set_config('checks.w1', w.id::text, false);
end $$;

\echo '— weddings: full plan sections and plan are protected'
do $$
declare
  wid uuid := current_setting('checks.w1')::uuid;
  message text;
begin
  message := public.error_of(format(
    $q$update public.weddings set sections = jsonb_set(sections, '{video}', '{"enabled": true}') where id = %L$q$, wid),
    'PT402');
  assert message = 'This section is included in the full plan', message;
  update public.weddings set partner1_name = 'Annalisa', plan = 'full', payment = '{"fake": true}',
    owner_id = 'bbbbbbbb-0000-0000-0000-000000000002' where id = wid;
  assert (select plan from public.weddings where id = wid) = 'free', 'plan unchanged';
  assert (select payment from public.weddings where id = wid) is null, 'payment unchanged';
  assert (select owner_id from public.weddings where id = wid) = 'aaaaaaaa-0000-0000-0000-000000000001';
  assert (select partner1_name from public.weddings where id = wid) = 'Annalisa', 'the rest is saved';
end $$;

\echo '— invitations: generated code, at most 20 on the free plan'
do $$
declare
  wid uuid := current_setting('checks.w1')::uuid;
  i public.invitations;
  message text;
begin
  insert into public.invitations (wedding_id, moments, name, code, opened)
  values (wid, array['lunch', 'ceremony', 'lunch'], '  The Rossi family ', 'CHOSEN', true)
  returning * into i;
  assert i.code ~ '^[A-Za-z0-9]{22}$', 'long random code: ' || i.code;
  assert i.name = 'The Rossi family' and not i.opened;
  assert i.moments = array['ceremony', 'lunch'], 'moments in the order of the day, no repetitions';
  perform set_config('checks.code', i.code, false);

  update public.invitations set code = 'OTHER', moments = array['cake_cutting'] where id = i.id;
  assert (select code from public.invitations where id = i.id) = i.code, 'printed QR codes never change';
  update public.invitations set moments = array['ceremony', 'lunch'] where id = i.id;

  perform public.error_of(
    format($q$insert into public.invitations (wedding_id, moments) values (%L, array['party'])$q$, wid), '23514');
  perform public.error_of(
    format($q$insert into public.invitations (wedding_id, moments) values (%L, '{}')$q$, wid), '23514');

  for n in 2..20 loop insert into public.invitations (wedding_id) values (wid); end loop;
  message := public.error_of(format('insert into public.invitations (wedding_id) values (%L)', wid), 'PT402');
  assert message like 'The free plan includes 20 invitations%', message;
end $$;
reset role;

\echo '— another user sees and touches nothing'
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
set role authenticated;
do $$
declare wid uuid := current_setting('checks.w1')::uuid;
begin
  assert (select count(*) from public.weddings) = 0, 'cannot see Anna''s wedding';
  assert (select count(*) from public.invitations) = 0, 'nor its invitations';
  update public.weddings set partner1_name = 'Hacker' where id = wid;
  delete from public.invitations where wedding_id = wid;
  perform public.error_of(format('insert into public.invitations (wedding_id) values (%L)', wid), '42501');
end $$;
reset role;
do $$ begin
  assert (select partner1_name from public.weddings) = 'Annalisa', 'change ignored';
  assert (select count(*) from public.invitations) = 20, 'invitations intact';
end $$;

\echo '— guests cannot read the tables'
set request.jwt.claim.sub = '';
set role anon;
do $$ begin
  perform public.error_of('select * from public.weddings', '42501');
  perform public.error_of('select * from public.guest_messages', '42501');
  perform public.error_of(
    'insert into public.guest_messages (wedding_id, sender, body) values (gen_random_uuid(), ''a'', ''b'')', '42501');
end $$;

\echo '— app: invitation opened with its code, in the app''s format'
do $$
declare
  j jsonb := public.open_invitation(current_setting('checks.code'));
  w jsonb := j -> 'matrimonio';
begin
  assert j ->> 'tipoInvito' = 'pranzo', j::text;
  assert j ->> 'codiceInvito' = current_setting('checks.code');
  assert w ->> 'dataMatrimonio' = '2027-06-12';
  assert w ->> 'nomeSposo1' = 'Annalisa';
  assert w ->> 'infoCerimonia' = '<p>Church</p>' and w ->> 'infoPranzo' = '<p>Villa</p>';
  assert not w ? 'infoFesta', 'only the moments of its kind';
  assert not w ? 'dataProposta';
  assert w ->> 'rsvp' like '%<bottonetelefono numero=''333&#39; x''>Anna &lt;b&gt;</bottonetelefono>%', w ->> 'rsvp';
  assert (w #>> '{sezioni,rsvp}')::boolean and (w #>> '{sezioni,partecipazione}')::boolean;
  assert not (w #>> '{sezioni,video}')::boolean;
  assert w -> 'config' = '{"videoStartup": false, "rsvpInApp": false}', (w -> 'config')::text;
  assert w -> 'listaImmagini' = '[]' and w -> 'linkAlbum' = '[]';
  perform public.error_of($q$select public.open_invitation('missing')$q$, 'PT404');
end $$;
reset role;
do $$ begin
  assert (select opened from public.invitations where code = current_setting('checks.code')), 'opened, for the couple';
end $$;

\echo '— app: guest messages and RSVP responses'
set role anon;
do $$
declare wid uuid := current_setting('checks.w1')::uuid;
begin
  perform public.send_guest_message(wid, ' Aunt Anna ', 'Congratulations!');
  perform public.error_of(format($q$select public.send_guest_message(%L, ' ', 'x')$q$, wid), 'PT400');
  perform public.error_of($q$select public.send_guest_message(gen_random_uuid(), 'a', 'b')$q$, 'PT404');
  perform public.send_rsvp(wid, current_setting('checks.code'), 'Rossi', true, 999, 'Coeliac');
  perform public.send_rsvp(wid, current_setting('checks.code'), 'rossi', false, 3, '');
  perform public.send_rsvp(wid, null, 'Bianchi', true, null, '');
  perform public.error_of(format($q$select public.send_rsvp(%L, null, '', true, 1, '')$q$, wid), 'PT400');
end $$;
reset role;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
set role authenticated;
do $$ begin
  assert (select sender from public.guest_messages) = 'Aunt Anna';
  assert (select count(*) from public.rsvp_responses) = 3;
  assert (select party_size from public.rsvp_responses where name = 'Rossi') = 50, 'party size capped';
  assert (select party_size from public.rsvp_responses where name = 'rossi') = 0, 'not attending counts zero';
  assert (select party_size from public.rsvp_responses where name = 'Bianchi') = 1;
  -- one per guest: for the Rossis the latest counts
  assert (select count(*) from public.latest_rsvp_responses) = 2;
  assert (select not attending from public.latest_rsvp_responses where lower(name) = 'rossi');
end $$;
reset role;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
set role authenticated;
do $$ begin
  assert (select count(*) from public.guest_messages) = 0 and (select count(*) from public.latest_rsvp_responses) = 0,
    'messages and responses only for the couple';
end $$;
reset role;

\echo '— full plan (switched on by the server): sections and gallery'
update public.weddings set plan = 'full', payment = '{"amount": 4900}';
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
set role authenticated;
do $$
declare
  wid uuid := current_setting('checks.w1')::uuid;
  j jsonb;
begin
  insert into public.invitations (wedding_id) values (wid); -- no limit now
  update public.weddings set notifications = '{"forced": true}', sections = sections || jsonb_build_object(
    'gallery', jsonb_build_object(
      'enabled', true,
      'images', jsonb_build_array('https://x.supabase.co/storage/v1/object/public/photos/a.jpg', 'https://x/b.jpg',
                                  'data:base64'),
      'albums', jsonb_build_array(jsonb_build_object('title', 'Photographer', 'url', 'https://studio.it/a'),
                                  jsonb_build_object('title', 'Scam', 'url', 'javascript:alert(1)'))),
    'video', jsonb_build_object('enabled', true, 'url', 'dQw4w9WgXcQ', 'autoplay', true))
  where id = wid;
  assert (select notifications #>> '{pendingPhotos,photos}' from public.weddings where id = wid) = '3',
    'photos to announce';
  assert (select notifications #>> '{pendingPhotos,albums}' from public.weddings where id = wid) = '2';
  assert not (select notifications ? 'forced' from public.weddings where id = wid), 'notifications stay the server''s';

  j := public.open_invitation(current_setting('checks.code')) -> 'matrimonio';
  assert (j #>> '{sezioni,video}')::boolean and (j #>> '{sezioni,momenti}')::boolean;
  assert j -> 'listaImmagini' = '["https://x.supabase.co/storage/v1/object/public/photos/a.jpg", "https://x/b.jpg"]',
    (j -> 'listaImmagini')::text;
  assert j -> 'linkAlbum' = '[{"url": "https://studio.it/a", "titolo": "Photographer"}]', (j -> 'linkAlbum')::text;
  assert (j #>> '{config,videoStartup}')::boolean;
end $$;

\echo '— app: an invitation with several moments, or without the ceremony'
do $$
declare
  wid uuid := current_setting('checks.w1')::uuid;
  both_parties text;
  party_only text;
  j jsonb;
begin
  update public.weddings set sections = jsonb_set(sections, '{participation,cakeCuttingInfo}', '"<p>Cake</p>"')
  where id = wid;
  insert into public.invitations (wedding_id, moments) values (wid, array['ceremony', 'lunch', 'cake_cutting'])
  returning code into both_parties;
  insert into public.invitations (wedding_id, moments) values (wid, array['cake_cutting'])
  returning code into party_only;

  j := public.open_invitation(both_parties);
  assert j ->> 'tipoInvito' = 'completo', j ->> 'tipoInvito';
  assert j #>> '{matrimonio,infoCerimonia}' = '<p>Church</p>' and j #>> '{matrimonio,infoPranzo}' = '<p>Villa</p>'
    and j #>> '{matrimonio,infoFesta}' = '<p>Cake</p>', 'all three moments';

  j := public.open_invitation(party_only);
  assert j ->> 'tipoInvito' = 'taglioTorta';
  assert not (j -> 'matrimonio') ? 'infoCerimonia' and not (j -> 'matrimonio') ? 'infoPranzo'
    and j #>> '{matrimonio,infoFesta}' = '<p>Cake</p>', 'only the party';
end $$;

\echo '— photos in Storage: only in the folder of one''s own weddings'
do $$
declare wid uuid := current_setting('checks.w1')::uuid;
begin
  insert into storage.objects (bucket_id, name) values ('photos', wid || '/cover.jpg');
  perform public.error_of(format($q$insert into storage.objects (bucket_id, name) values ('photos', '%s/x.jpg')$q$,
    gen_random_uuid()), '42501');
  perform public.error_of($q$insert into storage.objects (bucket_id, name) values ('photos', 'cover.jpg')$q$, '42501');
end $$;
reset role;

\echo '— guest accounts: invitations and RSVP saved on the account'
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
set role authenticated;
do $$
declare
  code text := current_setting('checks.code');
  wid uuid := current_setting('checks.w1')::uuid;
  j jsonb;
begin
  assert public.save_invitations(array[code, 'unknown-code']) = 1, 'unknown codes are skipped';
  assert public.save_invitations(array[code]) = 1, 'saving twice keeps one';
  perform public.error_of(format(
    'insert into public.saved_invitations (invitation_id) select id from public.invitations limit 1'), '42501');

  j := public.my_invitations();
  assert jsonb_array_length(j) = 1, j::text;
  assert j #>> '{0,codiceInvito}' = code and j #> '{0,matrimonio,nomeSposo1}' is not null;
  assert j -> 0 -> 'rispostaRsvp' = 'null', 'no response yet';

  perform public.send_rsvp(wid, code, 'Bruno', true, 3, 'Vegetarian');
  j := public.my_invitations();
  assert j #>> '{0,rispostaRsvp,nome}' = 'Bruno' and (j #>> '{0,rispostaRsvp,persone}')::int = 3
    and (j #>> '{0,rispostaRsvp,partecipa}')::boolean, j::text;

  assert public.wedding_summary(wid) is null, 'only the couple sees the numbers';

  perform public.forget_invitation(code);
  assert public.my_invitations() = '[]';
  assert public.save_invitations(array[code]) = 1;
end $$;
reset role;

-- a guest without an account has no user in the request
set request.jwt.claim.sub = '';
set role anon;
do $$
begin
  perform public.send_rsvp(current_setting('checks.w1')::uuid, current_setting('checks.code'), 'Carla', false, 0, '');
  perform public.error_of('select public.my_invitations()', '42501');
  perform public.error_of($q$select public.save_invitations(array['x'])$q$, '42501');
end $$;
reset role;

do $$
begin
  assert (select user_id from public.rsvp_responses where name = 'Bruno') = 'bbbbbbbb-0000-0000-0000-000000000002';
  assert (select user_id from public.rsvp_responses where name = 'Carla') is null, 'guests without an account';
end $$;

set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
set role authenticated;
do $$
declare
  s jsonb := public.wedding_summary(current_setting('checks.w1')::uuid);
begin
  assert (s ->> 'invitations')::int >= 1 and (s ->> 'opened')::int >= 1, s::text;
  assert (s ->> 'attending')::int >= 1 and (s ->> 'notAttending')::int >= 1, s::text;
  assert (s ->> 'people')::int >= 3, s::text;
  assert (select count(*) from public.saved_invitations) = 0, 'the couple does not see the guests'' lists';
end $$;
reset role;

\echo '— deleting an account: saved invitations go, RSVP responses stay'
do $$
begin
  delete from auth.users where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  assert not exists (select 1 from public.saved_invitations);
  assert (select user_id from public.rsvp_responses where name = 'Bruno') is null;
end $$;

\echo '— wedding without a date: the invitation does not open yet'
do $$
declare code text;
begin
  update public.weddings set wedding_date = null;
  select i.code into code from public.invitations i limit 1;
  perform public.error_of(format('select public.open_invitation(%L)', code), 'PT409');
end $$;

\echo '✓ all checks passed'
