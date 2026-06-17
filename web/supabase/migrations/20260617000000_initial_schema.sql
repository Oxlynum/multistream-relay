-- Profiles: one row per auth user, stores tier + Stripe IDs
create table public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  email                  text,
  tier                   text not null default 'free' check (tier in ('free', 'pro')),
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  created_at             timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- License keys
create table public.license_keys (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  key               text not null unique,
  tier              text not null default 'free' check (tier in ('free', 'pro')),
  active            boolean not null default true,
  last_validated_at timestamptz,
  created_at        timestamptz not null default now()
);

alter table public.license_keys enable row level security;

create policy "Users can read own keys"
  on public.license_keys for select
  using (auth.uid() = user_id);

-- Auto-create profile + free license key on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  new_key text;
begin
  -- Generate key in format SC-XXXX-XXXX-XXXX-XXXX
  new_key := 'SC-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4));

  insert into public.profiles (id, email, tier)
  values (new.id, new.email, 'free');

  insert into public.license_keys (user_id, key, tier)
  values (new.id, new_key, 'free');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
