-- familio: einmalige Ergänzung für bestehende Installationen
-- Im Supabase Dashboard unter SQL Editor > New query vollständig ausführen.

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

drop policy if exists "family members read member profiles" on public.profiles;
create policy "family members read member profiles" on public.profiles
for select to authenticated using (public.shares_family_with(id));

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
    raise exception 'Only family organizers can invite people';
  end if;

  insert into public.invitations (family_id, invited_by, email, message)
  values (target_family_id, auth.uid(), normalized_email, nullif(trim(invite_message), ''))
  on conflict (family_id, email) do update
    set invited_by = excluded.invited_by,
        message = excluded.message,
        status = 'pending',
        created_at = now(),
        accepted_at = null
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
    raise exception 'Invitation not found for this account';
  end if;

  insert into public.family_members (family_id, user_id, role)
  values (invitation.family_id, auth.uid(), 'member')
  on conflict do nothing;

  update public.invitations
  set status = 'accepted', accepted_at = now()
  where id = invitation.id;

  return invitation.family_id;
end;
$$;
