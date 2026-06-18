-- Simplified trigger: bare minimum to unblock signup.
-- Remove agent_api_keys insert temporarily to isolate the failure.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, tier, streaming_credits_seconds)
  values (new.id, new.email, 'free', 7200);
  return new;
exception when others then
  raise log 'handle_new_user failed: % %', SQLSTATE, SQLERRM;
  return new;
end;
$$;
