-- Guests with an account: the invitations they opened stay on the account
-- (the same list on every phone, back after reinstalling the app), with the
-- RSVP response they sent. Guests without an account keep working as before.

create table public.saved_invitations (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  invitation_id uuid not null references public.invitations (id) on delete cascade,
  saved_at timestamptz not null default clock_timestamp(),
  primary key (user_id, invitation_id)
);

alter table public.saved_invitations enable row level security;
revoke all on public.saved_invitations from anon, authenticated;
-- added only through save_invitations: knowing the code is what proves the
-- guest was invited
grant select, delete on public.saved_invitations to authenticated;

create policy "own saved invitations" on public.saved_invitations
for all to authenticated
using (user_id = auth.uid());

-- who sent the response, when signed in: it comes back on their other phones
alter table public.rsvp_responses
  add column user_id uuid references auth.users (id) on delete set null;

create index rsvp_responses_user on public.rsvp_responses (user_id, created_at desc) where user_id is not null;

create or replace function public.send_rsvp(
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
  insert into public.rsvp_responses (wedding_id, invitation_code, name, attending, party_size, notes, user_id)
  values (
    send_rsvp.wedding_id,
    nullif(trim(coalesce(invitation_code, '')), ''),
    name,
    coalesce(attending, false),
    case when coalesce(attending, false) then least(greatest(coalesce(party_size, 1), 1), 50) else 0 end,
    trim(coalesce(notes, '')),
    auth.uid()
  );
end
$$;

-- Saves on the account the invitations of [codes] (those opened on the
-- phone, also before signing in). Unknown codes are skipped; returns how
-- many invitations the account has now.
create function public.save_invitations(codes text[]) returns int
language plpgsql volatile security definer set search_path = public
as $$
declare
  total int;
begin
  if auth.uid() is null then
    raise exception using errcode = 'PT401', message = 'Sign in to save the invitations';
  end if;
  if cardinality(codes) > 100 then
    raise exception using errcode = 'PT400', message = 'Too many invitations at once';
  end if;
  insert into public.saved_invitations (user_id, invitation_id)
  select auth.uid(), i.id from public.invitations i where i.code = any(codes)
  on conflict do nothing;
  select count(*) into total from public.saved_invitations where user_id = auth.uid();
  return total;
end
$$;

-- Removes the invitation [code] from the account.
create function public.forget_invitation(code text) returns void
language sql volatile security definer set search_path = public
as $$
  delete from public.saved_invitations s
  using public.invitations i
  where s.invitation_id = i.id and i.code = forget_invitation.code and s.user_id = auth.uid()
$$;

-- The invitations saved on the account, in the app's format (the same as
-- open_invitation), oldest first, each with the latest RSVP response the
-- user sent for it ("rispostaRsvp", null if none). Weddings without a date
-- are left out, as open_invitation does.
create function public.my_invitations() returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = 'PT401', message = 'Sign in to see the saved invitations';
  end if;
  return coalesce((
    select jsonb_agg(public.invitation_for_app(w, i) || jsonb_build_object('rispostaRsvp', (
        select jsonb_build_object(
          'nome', r.name,
          'partecipa', r.attending,
          'persone', r.party_size,
          'note', r.notes,
          'inviataIl', (extract(epoch from r.created_at) * 1000)::bigint)
        from public.rsvp_responses r
        where r.invitation_code = i.code and r.user_id = auth.uid()
        order by r.created_at desc
        limit 1))
      order by s.saved_at)
    from public.saved_invitations s
    join public.invitations i on i.id = s.invitation_id
    join public.weddings w on w.id = i.wedding_id
    where s.user_id = auth.uid() and w.wedding_date is not null
  ), '[]');
end
$$;

revoke execute on function public.save_invitations(text[]), public.forget_invitation(text),
  public.my_invitations() from public, anon;
grant execute on function public.save_invitations(text[]), public.forget_invitation(text),
  public.my_invitations() to authenticated;

-- Numbers of a wedding for the couple's page in the app: invitations
-- (sent and opened), the latest RSVP responses and the messages. Null for
-- anyone but the couple.
create function public.wedding_summary(wedding_id uuid) returns jsonb
language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object(
    'invitations', (select count(*) from public.invitations i where i.wedding_id = wedding_summary.wedding_id),
    'opened', (select count(*) from public.invitations i where i.wedding_id = wedding_summary.wedding_id and i.opened),
    'attending', (select count(*) from public.latest_rsvp_responses r
                  where r.wedding_id = wedding_summary.wedding_id and r.attending),
    'notAttending', (select count(*) from public.latest_rsvp_responses r
                     where r.wedding_id = wedding_summary.wedding_id and not r.attending),
    'people', (select coalesce(sum(r.party_size), 0) from public.latest_rsvp_responses r
               where r.wedding_id = wedding_summary.wedding_id),
    'messages', (select count(*) from public.guest_messages m where m.wedding_id = wedding_summary.wedding_id)
  )
  -- security invoker: the counts also go through RLS
  where public.owns_wedding(wedding_summary.wedding_id)
$$;

revoke execute on function public.wedding_summary(uuid) from public, anon;
grant execute on function public.wedding_summary(uuid) to authenticated;
