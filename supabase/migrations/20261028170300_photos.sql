-- Wedding photos (cover and gallery) in Supabase Storage: public read access,
-- since the app downloads them from a plain address; write access only for
-- couples, inside their own wedding's folder ("<wedding id>/<file name>").

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 10 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- True if [path] is inside the folder of a wedding of the signed-in user.
create function public.is_own_wedding_photo(path text) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.weddings w
    where w.id::text = split_part(path, '/', 1) and w.owner_id = auth.uid()
  )
$$;

revoke execute on function public.is_own_wedding_photo(text) from public, anon;
grant execute on function public.is_own_wedding_photo(text) to authenticated;

create policy "photos: couples upload" on storage.objects
for insert to authenticated
with check (bucket_id = 'photos' and public.is_own_wedding_photo(name));

create policy "photos: couples replace" on storage.objects
for update to authenticated
using (bucket_id = 'photos' and public.is_own_wedding_photo(name))
with check (bucket_id = 'photos' and public.is_own_wedding_photo(name));

create policy "photos: couples delete" on storage.objects
for delete to authenticated
using (bucket_id = 'photos' and public.is_own_wedding_photo(name));

-- Storage must be able to read the couple's files to replace or delete them
create policy "photos: couples see their own" on storage.objects
for select to authenticated
using (bucket_id = 'photos' and public.is_own_wedding_photo(name));
