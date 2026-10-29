-- Who sees and changes what. Couples ("authenticated") only work on their
-- own weddings; guests ("anon") never touch the tables and go through the
-- functions that take the invitation code.

alter table public.weddings enable row level security;
alter table public.invitations enable row level security;
alter table public.guest_messages enable row level security;
alter table public.rsvp_responses enable row level security;

-- explicit privileges, without relying on the project defaults
revoke all on public.weddings, public.invitations, public.guest_messages, public.rsvp_responses,
  public.latest_rsvp_responses from anon, authenticated;
grant select, insert, update, delete on public.weddings, public.invitations to authenticated;
-- messages and responses come from guests: couples read them and may
-- delete them (e.g. a duplicate or a prank)
grant select, delete on public.guest_messages, public.rsvp_responses to authenticated;
grant select on public.latest_rsvp_responses to authenticated;

-- The helper functions (plan rules, new code…) stay executable by everyone:
-- triggers and column defaults run with the role of whoever saves, and they
-- reveal nothing.

-- True if wedding [id] belongs to the signed-in user.
create function public.owns_wedding(id uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.weddings w where w.id = $1 and w.owner_id = auth.uid()) $$;

revoke execute on function public.owns_wedding(uuid) from public, anon;
grant execute on function public.owns_wedding(uuid) to authenticated;

create policy "own weddings" on public.weddings
for all to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "invitations of own weddings" on public.invitations
for all to authenticated
using (public.owns_wedding(wedding_id))
with check (public.owns_wedding(wedding_id));

create policy "read messages of own weddings" on public.guest_messages
for select to authenticated
using (public.owns_wedding(wedding_id));

create policy "delete messages of own weddings" on public.guest_messages
for delete to authenticated
using (public.owns_wedding(wedding_id));

create policy "read responses of own weddings" on public.rsvp_responses
for select to authenticated
using (public.owns_wedding(wedding_id));

create policy "delete responses of own weddings" on public.rsvp_responses
for delete to authenticated
using (public.owns_wedding(wedding_id));
