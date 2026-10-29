-- MarryMe: weddings, invitations, guest messages and RSVP responses.
--
-- Couples (Supabase Auth users) manage their weddings and invitations from
-- the web panel. Guests have no account: they go through the functions in
-- 20261028170200_guests.sql, which require the invitation code.
--
-- Errors meant for the panel use SQLSTATE "PTnnn": the Supabase API
-- (PostgREST) answers with HTTP status nnn and the message.

-- ------------------------------------------------------------------ plans

-- Plan rules: used by the triggers below, read by the panel with
-- rpc('plans').
create function public.plans() returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
    'free', jsonb_build_object('maxInvitations', 20, 'sections', jsonb_build_array('participation', 'rsvp')),
    'full', jsonb_build_object('price', 4900, 'currency', 'eur')
  )
$$;

-- The sections of the guest app, as keys of weddings.sections.
create function public.section_keys() returns text[]
language sql immutable
as $$ select array['participation', 'rsvp', 'giftList', 'guestbook', 'video', 'gallery'] $$;

-- True if [plan] includes [section] (e.g. 'video').
create function public.section_allowed(plan text, section text) returns boolean
language sql immutable
as $$ select plan = 'full' or section in ('participation', 'rsvp') $$;

-- True if a section is switched on in [sections].
create function public.section_enabled(sections jsonb, section text) returns boolean
language sql immutable
as $$ select coalesce((sections #>> array[section, 'enabled'])::boolean, false) $$;

-- True when the change comes from the API on behalf of a couple or a guest;
-- false for server code (payments, notifications, migrations).
create function public.is_client() returns boolean
language sql stable
as $$ select current_user in ('authenticated', 'anon') $$;

-- Number of items of a JSON array, 0 if it is not an array.
create function public.list_length(value jsonb) returns int
language sql immutable
as $$ select case when jsonb_typeof(value) = 'array' then jsonb_array_length(value) else 0 end $$;

-- --------------------------------------------------------------- weddings

create table public.weddings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  partner1_name text,
  partner2_name text,
  wedding_date date,
  proposal_date date,
  -- address of the cover photo (Storage, a website or an app asset)
  cover_url text,
  -- content and switches of the guest app sections, as the panel writes them:
  -- { participation: { enabled, ceremonyInfo, lunchInfo, cakeCuttingInfo },
  --   rsvp: { enabled, text, contacts: [{ label, phone }], inAppResponse },
  --   giftList: { enabled, text, iban, url },
  --   guestbook: { enabled, prompt },
  --   video: { enabled, url, autoplay },
  --   gallery: { enabled, images: [url], albums: [{ title, url }] } }
  sections jsonb not null default '{}' check (jsonb_typeof(sections) = 'object'),
  -- changed by the server only
  plan text not null default 'free' check (plan in ('free', 'full')),
  payment jsonb,
  notifications jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index weddings_owner on public.weddings (owner_id);
create index weddings_date on public.weddings (wedding_date);

-- True if guests can see the gallery: switched on and included in the plan.
create function public.gallery_visible(w public.weddings) returns boolean
language sql immutable
as $$ select public.section_enabled(w.sections, 'gallery') and public.section_allowed(w.plan, 'gallery') $$;

-- Photos and albums guests can see (zero while the gallery is hidden).
create function public.visible_gallery(w public.weddings) returns table (photos int, albums int)
language sql immutable
as $$
  select
    case when public.gallery_visible(w) then public.list_length(w.sections #> '{gallery,images}') else 0 end,
    case when public.gallery_visible(w) then public.list_length(w.sections #> '{gallery,albums}') else 0 end
$$;

create function public.weddings_before_save() returns trigger
language plpgsql
as $$
declare
  section text;
  before_save record;
  after_save record;
  pending jsonb;
begin
  if tg_op = 'INSERT' then
    if public.is_client() then
      -- new weddings start on the free plan, with only its sections
      new.owner_id := auth.uid();
      new.plan := 'free';
      new.payment := null;
      new.notifications := '{}';
      foreach section in array public.section_keys() loop
        if not public.section_allowed('free', section) and public.section_enabled(new.sections, section) then
          new.sections := jsonb_set(new.sections, array[section, 'enabled'], 'false');
        end if;
      end loop;
    end if;
    return new;
  end if;

  if public.is_client() then
    -- only a payment changes the plan; the rest belongs to the server
    new.id := old.id;
    new.owner_id := old.owner_id;
    new.plan := old.plan;
    new.payment := old.payment;
    new.notifications := old.notifications;
    new.created_at := old.created_at;
    -- switching on a section of the full plan requires the payment
    foreach section in array public.section_keys() loop
      if public.section_enabled(new.sections, section)
         and not public.section_enabled(old.sections, section)
         and not public.section_allowed(new.plan, section) then
        raise exception using errcode = 'PT402', message = 'This section is included in the full plan';
      end if;
    end loop;
  end if;

  -- photos and albums guests see now and did not see before (added, or made
  -- visible by switching on the gallery) are announced with a notification
  select * into before_save from public.visible_gallery(old);
  select * into after_save from public.visible_gallery(new);
  if after_save.photos > before_save.photos or after_save.albums > before_save.albums then
    pending := new.notifications -> 'pendingPhotos';
    new.notifications := new.notifications || jsonb_build_object('pendingPhotos', jsonb_build_object(
      'photos', coalesce((pending ->> 'photos')::int, 0) + greatest(after_save.photos - before_save.photos, 0),
      'albums', coalesce((pending ->> 'albums')::int, 0) + greatest(after_save.albums - before_save.albums, 0),
      'since', (extract(epoch from now()) * 1000)::bigint
    ));
  end if;

  new.updated_at := now();
  return new;
end
$$;

create trigger weddings_before_save
before insert or update on public.weddings
for each row execute function public.weddings_before_save();

-- ------------------------------------------------------------ invitations

-- Secret invitation code, in the link and the QR code: 22 base62
-- characters (over 128 random bits, from two v4 uuids).
create function public.new_invitation_code() returns text
language sql volatile
as $$
  select string_agg(
    substr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', get_byte(b, i) % 62 + 1, 1), ''
    order by i)
  from (select uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()) as b) x,
       generate_series(0, 21) i
$$;

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  code text not null unique default public.new_invitation_code(),
  -- which moments of the day the guest is invited to
  kind text not null default 'ceremony' check (kind in ('ceremony', 'lunch', 'cake_cutting')),
  -- e.g. "The Rossi family"
  name text check (char_length(name) <= 120),
  -- the guest opened it in the app
  opened boolean not null default false,
  created_at timestamptz not null default now()
);

create index invitations_wedding on public.invitations (wedding_id);

create function public.invitations_before_save() returns trigger
language plpgsql
as $$
declare
  wedding public.weddings;
  existing int;
  max_free int := (public.plans() #>> '{free,maxInvitations}')::int;
begin
  new.name := nullif(trim(new.name), '');
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

create trigger invitations_before_save
before insert or update on public.invitations
for each row execute function public.invitations_before_save();

-- ------------------------------------------- guest messages and RSVP responses
-- Written only by the guest functions; couples read them.

create table public.guest_messages (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  sender text not null check (char_length(sender) between 1 and 120),
  body text not null check (char_length(body) between 1 and 5000),
  -- the actual instant, not the start of the transaction: arrival order
  created_at timestamptz not null default clock_timestamp()
);

create index guest_messages_wedding on public.guest_messages (wedding_id, created_at desc);

create table public.rsvp_responses (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  invitation_code text,
  name text not null check (char_length(name) between 1 and 120),
  attending boolean not null,
  -- including whoever answers; 0 when not attending
  party_size int not null check (party_size between 0 and 50),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default clock_timestamp()
);

create index rsvp_responses_wedding on public.rsvp_responses (wedding_id, created_at desc);

-- One response per guest: if they answered more than once, the latest counts.
create view public.latest_rsvp_responses with (security_invoker = true) as
select distinct on (wedding_id, coalesce(invitation_code, ''), lower(name))
  id, wedding_id, invitation_code, name, attending, party_size, notes, created_at
from public.rsvp_responses
order by wedding_id, coalesce(invitation_code, ''), lower(name), created_at desc;
