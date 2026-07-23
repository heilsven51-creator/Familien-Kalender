-- familio: Datenbank, Zugriffsregeln und privater Dateispeicher
-- Einmal vollständig im Supabase Dashboard unter SQL Editor > New query ausführen.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null check (char_length(display_name) between 1 and 60),
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 150),
  event_date date not null,
  event_time time,
  calendar text not null default 'familie',
  reminder_minutes integer,
  attendees text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 150),
  done boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  email text not null,
  message text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'cancelled')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (family_id, email)
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  uploaded_by uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  name text not null,
  content_type text,
  byte_size bigint not null check (byte_size >= 0),
  created_at timestamptz not null default now()
);

create index if not exists events_family_date_idx on public.events (family_id, event_date);
create index if not exists tasks_family_created_idx on public.tasks (family_id, created_at desc);
create index if not exists files_family_created_idx on public.files (family_id, created_at desc);
create index if not exists invitations_email_idx on public.invitations (lower(email));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  new_family_id uuid;
  new_name text := coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1));
  new_family_name text := coalesce(nullif(new.raw_user_meta_data ->> 'family_name', ''), new_name || ' Familie');
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, new_name)
  on conflict (id) do nothing;

  insert into public.families (name, created_by)
  values (new_family_name, new.id)
  returning id into new_family_id;

  insert into public.family_members (family_id, user_id, role)
  values (new_family_id, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_family_member(target_family_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.family_members
    where family_id = target_family_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_family_owner(target_family_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.family_members
    where family_id = target_family_id and user_id = auth.uid() and role = 'owner'
  );
$$;

-- Lets a signed-in person see the profile cards of people who share a family room.
create or replace function public.shares_family_with(target_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.family_members mine
    join public.family_members theirs on theirs.family_id = mine.family_id
    where mine.user_id = auth.uid() and theirs.user_id = target_user_id
  );
$$;

revoke all on function public.shares_family_with(uuid) from public;
grant execute on function public.shares_family_with(uuid) to authenticated;

create or replace function public.create_family_invitation(target_family_id uuid, invitee_email text, invite_message text default null)
returns public.invitations
language plpgsql security definer set search_path = public
as $$
declare
  result public.invitations;
  normalized_email text := lower(trim(invitee_email));
begin
  if normalized_email = '' or position('@' in normalized_email) = 0 then
    raise exception 'A valid email address is required';
  end if;

  if normalized_email = lower(coalesce((select email from public.profiles where id = auth.uid()), '')) then
    raise exception 'You cannot invite yourself';
  end if;

  if not public.is_family_owner(target_family_id) then
    raise exception 'Nur Organisatoren können einladen';
  end if;

  insert into public.invitations (family_id, invited_by, email, message)
  values (target_family_id, auth.uid(), normalized_email, nullif(trim(invite_message), ''))
  on conflict (family_id, email) do update
    set invited_by = excluded.invited_by, message = excluded.message, status = 'pending', created_at = now(), accepted_at = null
  returning * into result;
  return result;
end;
$$;

create or replace function public.accept_family_invitation(invitation_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare invitation public.invitations;
begin
  select * into invitation from public.invitations
  where id = invitation_id
    and status = 'pending'
    and lower(email) = lower(coalesce((select email from public.profiles where id = auth.uid()), ''))
  for update;

  if invitation.id is null then
    raise exception 'Einladung nicht gefunden';
  end if;

  insert into public.family_members (family_id, user_id, role)
  values (invitation.family_id, auth.uid(), 'member')
  on conflict do nothing;

  update public.invitations set status = 'accepted', accepted_at = now() where id = invitation.id;
  return invitation.family_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.events enable row level security;
alter table public.tasks enable row level security;
alter table public.invitations enable row level security;
alter table public.files enable row level security;

create policy "users read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "users update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "family members read member profiles" on public.profiles;
create policy "family members read member profiles" on public.profiles
for select to authenticated using (public.shares_family_with(id));

create policy "members read families" on public.families for select to authenticated using (public.is_family_member(id));
create policy "owners update families" on public.families for update to authenticated using (public.is_family_owner(id)) with check (public.is_family_owner(id));

create policy "members read memberships" on public.family_members for select to authenticated using (public.is_family_member(family_id));

create policy "members read events" on public.events for select to authenticated using (public.is_family_member(family_id));
create policy "members create events" on public.events for insert to authenticated with check (public.is_family_member(family_id) and created_by = auth.uid());
create policy "members update events" on public.events for update to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
create policy "members delete events" on public.events for delete to authenticated using (public.is_family_member(family_id));

create policy "members read tasks" on public.tasks for select to authenticated using (public.is_family_member(family_id));
create policy "members create tasks" on public.tasks for insert to authenticated with check (public.is_family_member(family_id) and created_by = auth.uid());
create policy "members update tasks" on public.tasks for update to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
create policy "members delete tasks" on public.tasks for delete to authenticated using (public.is_family_member(family_id));

create policy "members or recipients read invitations" on public.invitations for select to authenticated using (public.is_family_member(family_id) or lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy "owners cancel invitations" on public.invitations for update to authenticated using (public.is_family_owner(family_id)) with check (public.is_family_owner(family_id));

create policy "members read file metadata" on public.files for select to authenticated using (public.is_family_member(family_id));
create policy "members create file metadata" on public.files for insert to authenticated with check (public.is_family_member(family_id) and uploaded_by = auth.uid());
create policy "members delete file metadata" on public.files for delete to authenticated using (public.is_family_member(family_id));

insert into storage.buckets (id, name, public, file_size_limit)
values ('family-files', 'family-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

create policy "members read family files" on storage.objects for select to authenticated
using (bucket_id = 'family-files' and public.is_family_member((storage.foldername(name))[1]::uuid));
create policy "members upload family files" on storage.objects for insert to authenticated
with check (bucket_id = 'family-files' and public.is_family_member((storage.foldername(name))[1]::uuid));
create policy "members delete family files" on storage.objects for delete to authenticated
using (bucket_id = 'family-files' and public.is_family_member((storage.foldername(name))[1]::uuid));
