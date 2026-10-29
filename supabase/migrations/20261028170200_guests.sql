-- Functions for the guest app: no account, the secret invitation code (in
-- the link and the QR code) is enough. Called by the "api" Edge Function,
-- which answers on the same routes as the old backend.

-- Text inside the app's HTML, with no tags.
create function public.html_text(value text) returns text
language sql immutable
as $$ select replace(replace(replace(coalesce(value, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') $$;

-- Value of an HTML attribute between single quotes.
create function public.html_attribute(value text) returns text
language sql immutable
as $$ select replace(replace(public.html_text(value), '''', '&#39;'), '"', '&quot;') $$;

-- Full web link (no javascript: or other schemes).
create function public.is_web_link(value text) returns boolean
language sql immutable
as $$ select coalesce(value ~* '^https?://[^\s/]+\.[^\s]+$', false) $$;

-- The wedding as the guest app reads it for invitation [i]: each guest sees
-- the moments of their invitation kind and only the sections in the plan.
-- The JSON keys are the ones the app already reads (they are part of its
-- contract and stay as they are).
create function public.invitation_for_app(w public.weddings, i public.invitations) returns jsonb
language plpgsql stable
as $$
declare
  s jsonb := w.sections;
  -- names used by the app
  app_kind text := case i.kind when 'lunch' then 'pranzo' when 'cake_cutting' then 'taglioTorta' else 'cerimonia' end;
  app_sections jsonb := jsonb_build_object(
    'participation', 'partecipazione', 'rsvp', 'rsvp', 'giftList', 'listaNozze',
    'guestbook', 'messaggio', 'video', 'video', 'gallery', 'momenti');
  video_url text := coalesce(s #>> '{video,url}', '');
  visible jsonb := '{}';
  section text;
  rsvp text;
  gift_list text;
  wedding jsonb;
begin
  foreach section in array public.section_keys() loop
    visible := visible || jsonb_build_object(
      app_sections ->> section,
      public.section_enabled(s, section) and public.section_allowed(w.plan, section));
  end loop;
  -- the video section needs a video
  visible := visible || jsonb_build_object('video', (visible ->> 'video')::boolean and video_url <> '');

  -- RSVP: the couple's text and a call button for each contact
  select concat_ws(E'\n', coalesce(s #>> '{rsvp,text}', ''), string_agg(
           format('<bottonetelefono numero=''%s''>%s</bottonetelefono>',
                  public.html_attribute(c ->> 'phone'), public.html_text(c ->> 'label')), E'\n'))
    into rsvp
  from jsonb_array_elements(case when jsonb_typeof(s #> '{rsvp,contacts}') = 'array'
                                 then s #> '{rsvp,contacts}' else '[]' end) c
  where jsonb_typeof(c) = 'object';

  gift_list := concat_ws(E'\n',
    coalesce(s #>> '{giftList,text}', ''),
    case when coalesce(s #>> '{giftList,iban}', '') <> ''
         then format('<iban>%s</iban>', public.html_text(s #>> '{giftList,iban}')) end,
    case when public.is_web_link(s #>> '{giftList,url}')
         then format('<p><a href=''%s''>Apri la lista nozze</a></p>', public.html_attribute(s #>> '{giftList,url}')) end);

  wedding := jsonb_build_object(
    'id', w.id,
    'nomeSposo1', w.partner1_name,
    'nomeSposo2', w.partner2_name,
    'dataMatrimonio', to_char(w.wedding_date, 'YYYY-MM-DD'),
    'urlImmagine', w.cover_url,
    'urlVideo', video_url,
    'infoCerimonia', s #>> '{participation,ceremonyInfo}',
    'rsvp', rsvp,
    'linkListaNozze', gift_list,
    'listaImmagini', coalesce((
      select jsonb_agg(url) from jsonb_array_elements_text(
        case when jsonb_typeof(s #> '{gallery,images}') = 'array' then s #> '{gallery,images}' else '[]' end) url
      where url ~* '^https?://' or url like 'assets/%'), '[]'),
    'linkAlbum', coalesce((
      select jsonb_agg(jsonb_build_object('titolo', coalesce(a ->> 'title', ''), 'url', a ->> 'url'))
      from jsonb_array_elements(
        case when jsonb_typeof(s #> '{gallery,albums}') = 'array' then s #> '{gallery,albums}' else '[]' end) a
      where jsonb_typeof(a) = 'object' and public.is_web_link(a ->> 'url')), '[]'),
    'sezioni', visible,
    'config', jsonb_build_object(
      'videoStartup', coalesce((s #>> '{video,autoplay}')::boolean, false),
      -- in-app response form, if the couple switched it on
      'rsvpInApp', (visible ->> 'rsvp')::boolean and coalesce((s #>> '{rsvp,inAppResponse}')::boolean, false))
  );
  if w.proposal_date is not null then
    wedding := wedding || jsonb_build_object('dataProposta', to_char(w.proposal_date, 'YYYY-MM-DD'));
  end if;
  if i.kind = 'lunch' then
    wedding := wedding || jsonb_build_object('infoPranzo', s #>> '{participation,lunchInfo}');
  elsif i.kind = 'cake_cutting' then
    wedding := wedding || jsonb_build_object('infoFesta', s #>> '{participation,cakeCuttingInfo}');
  end if;

  return jsonb_build_object('matrimonio', wedding, 'tipoInvito', app_kind, 'codiceInvito', i.code);
end
$$;

-- Invitation [code] for the guest app; marks it as opened, so the couple
-- sees it in the panel.
create function public.open_invitation(code text) returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  i public.invitations;
  w public.weddings;
begin
  select * into i from public.invitations where invitations.code = open_invitation.code;
  if found then
    select * into w from public.weddings where id = i.wedding_id;
  end if;
  if i.id is null or w.id is null then
    raise exception using errcode = 'PT404', message = 'Invitation not found: check the link you received';
  end if;
  if w.wedding_date is null then
    raise exception using errcode = 'PT409', message = 'The wedding has no date yet';
  end if;
  if not i.opened then
    update public.invitations set opened = true where id = i.id;
  end if;
  return public.invitation_for_app(w, i);
end
$$;

-- A guest's message to the couple (the guestbook).
create function public.send_guest_message(wedding_id uuid, sender text, body text) returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  sender := trim(coalesce(sender, ''));
  body := trim(coalesce(body, ''));
  if sender = '' or body = '' then
    raise exception using errcode = 'PT400', message = 'Sender and message are required';
  end if;
  if char_length(sender) > 120 or char_length(body) > 5000 then
    raise exception using errcode = 'PT400', message = 'The message is too long';
  end if;
  if not exists (select 1 from public.weddings w where w.id = send_guest_message.wedding_id) then
    raise exception using errcode = 'PT404', message = 'Wedding not found';
  end if;
  insert into public.guest_messages (wedding_id, sender, body)
  values (send_guest_message.wedding_id, sender, body);
end
$$;

-- A guest's RSVP response; whoever is not attending counts zero people.
create function public.send_rsvp(
  wedding_id uuid, invitation_code text, name text, attending boolean, party_size int, notes text
) returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  name := trim(coalesce(name, ''));
  if name = '' then
    raise exception using errcode = 'PT400', message = 'The name is required';
  end if;
  if char_length(name) > 120 or char_length(coalesce(notes, '')) > 2000 then
    raise exception using errcode = 'PT400', message = 'The response is too long';
  end if;
  if not exists (select 1 from public.weddings w where w.id = send_rsvp.wedding_id) then
    raise exception using errcode = 'PT404', message = 'Wedding not found';
  end if;
  insert into public.rsvp_responses (wedding_id, invitation_code, name, attending, party_size, notes)
  values (
    send_rsvp.wedding_id,
    nullif(trim(coalesce(invitation_code, '')), ''),
    name,
    coalesce(attending, false),
    case when coalesce(attending, false) then least(greatest(coalesce(party_size, 1), 1), 50) else 0 end,
    trim(coalesce(notes, ''))
  );
end
$$;

-- only these three for guests (and couples, to try them out)
revoke execute on function public.open_invitation(text), public.send_guest_message(uuid, text, text),
  public.send_rsvp(uuid, text, text, boolean, int, text),
  public.invitation_for_app(public.weddings, public.invitations) from public;
grant execute on function public.open_invitation(text), public.send_guest_message(uuid, text, text),
  public.send_rsvp(uuid, text, text, boolean, int, text) to anon, authenticated;
