-- Enable pgcrypto so digest() is available in the handle_new_user trigger.
create extension if not exists pgcrypto;

-- Re-apply the trigger function now that pgcrypto is loaded.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  new_key     text;
  raw_api_key text;
begin
  new_key := 'SC-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4));

  raw_api_key := encode(gen_random_bytes(32), 'hex');

  insert into public.profiles (id, email, tier, streaming_credits_seconds)
  values (new.id, new.email, 'free', 7200);

  insert into public.license_keys (user_id, key, tier)
  values (new.id, new_key, 'free');

  insert into public.agent_api_keys (user_id, key_hash)
  values (new.id, encode(digest(raw_api_key, 'sha256'), 'hex'));

  return new;
end;
$$;
