-- An invitation covers one or more moments of the day (ceremony, lunch,
-- cake cutting) instead of a single kind: e.g. lunch and cake cutting, or
-- only the party without the ceremony.

alter table public.invitations add column moments text[] not null default array['ceremony'];

-- the old kinds always included the ceremony
update public.invitations set moments = case kind
  when 'lunch' then array['ceremony', 'lunch']
  when 'cake_cutting' then array['ceremony', 'cake_cutting']
  else array['ceremony']
end;

alter table public.invitations drop column kind;

alter table public.invitations add constraint invitations_moments_valid check (
  cardinality(moments) between 1 and 3
  and moments <@ array['ceremony', 'lunch', 'cake_cutting']
);

-- The moments in the order of the day, without repetitions.
create function public.ordered_moments(moments text[]) returns text[]
language sql immutable
as $$
  select coalesce(array_agg(m order by array_position(array['ceremony', 'lunch', 'cake_cutting'], m)), '{}')
  from (select distinct unnest(moments) m) x
$$;

create or replace function public.invitations_before_save() returns trigger
language plpgsql
as $$
declare
  wedding public.weddings;
  existing int;
  max_free int := (public.plans() #>> '{free,maxInvitations}')::int;
begin
  new.name := nullif(trim(new.name), '');
  new.moments := public.ordered_moments(new.moments);
  if tg_op = 'INSERT' then
    if public.is_client() then
      -- the server always picks the code: it must be impossible to guess
      new.code := public.new_invitation_code();
      new.opened := false;
    end if;
    select * into wedding from public.weddings where id = new.wedding_id;
    if wedding.plan = 'free' then
      select count(*) into existing from public.invitations where wedding_id = new.wedding_id;
      if existing >= max_free then
        raise exception using errcode = 'PT402',
          message = format('The free plan includes %s invitations: upgrade to the full plan to create more', max_free);
      end if;
    end if;
    return new;
  end if;

  if public.is_client() then
    -- the code of QR codes already printed never changes
    new.id := old.id;
    new.code := old.code;
    new.wedding_id := old.wedding_id;
    new.created_at := old.created_at;
  end if;
  return new;
end
$$;

-- The guest app gets the details of each moment of the invitation (it shows
-- whichever it receives). "tipoInvito" stays for the app's contract.
create or replace function public.invitation_for_app(w public.weddings, i public.invitations) returns jsonb
language plpgsql stable
as $$
declare
  s jsonb := w.sections;
  app_kind text := case
    when i.moments @> array['lunch', 'cake_cutting'] then 'completo'
    when 'lunch' = any(i.moments) then 'pranzo'
    when 'cake_cutting' = any(i.moments) then 'taglioTorta'
    else 'cerimonia'
  end;
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
  -- each guest sees only the moments of their invitation
  if 'ceremony' = any(i.moments) then
    wedding := wedding || jsonb_build_object('infoCerimonia', s #>> '{participation,ceremonyInfo}');
  end if;
  if 'lunch' = any(i.moments) then
    wedding := wedding || jsonb_build_object('infoPranzo', s #>> '{participation,lunchInfo}');
  end if;
  if 'cake_cutting' = any(i.moments) then
    wedding := wedding || jsonb_build_object('infoFesta', s #>> '{participation,cakeCuttingInfo}');
  end if;

  return jsonb_build_object('matrimonio', wedding, 'tipoInvito', app_kind, 'codiceInvito', i.code);
end
$$;

revoke execute on function public.invitation_for_app(public.weddings, public.invitations) from public;
