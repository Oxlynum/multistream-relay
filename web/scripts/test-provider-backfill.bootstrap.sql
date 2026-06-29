-- Minimal schema + seed rows to exercise the 000011 provider backfill logic on a
-- throwaway Postgres (termination-system-plan Phase 2). Only the columns the backfill
-- touches are modeled — the migration is purely 3 guarded UPDATEs, so this isolates the
-- recovery logic without replaying all 11 migrations.

create table public.gpu_instances (
  id        serial primary key,
  tag       text,                       -- test label
  provider  text                        -- nullable here to test both NULL and '' blanks
);

create table public.relay_nodes (
  id        serial primary key,
  tag       text,
  provider  text not null,              -- NOT NULL in live schema; '' is the blank state
  racers    jsonb default '[]'::jsonb
);

create table public.vps_hubs (
  id        serial primary key,
  tag       text,
  provider  text
);

-- gpu_instances: a '' blank, a NULL blank, and an already-correct row.
insert into public.gpu_instances (tag, provider) values
  ('gpu_blank_empty', ''),
  ('gpu_blank_null',  null),
  ('gpu_already_vast','vast');

-- relay_nodes: a '' blank recoverable from a runpod racer, a '' blank recoverable from a
-- vast racer, a '' blank with NO racer (must stay blank — no box to route), and an
-- already-stamped row (must not change).
insert into public.relay_nodes (tag, provider, racers) values
  ('node_blank_runpod', '', '[{"provider":"runpod","provider_id":"rp-1","state":"booting"}]'::jsonb),
  ('node_blank_vast',   '', '[{"provider":"vast","provider_id":"v-9","state":"ready"}]'::jsonb),
  ('node_blank_norace', '', '[]'::jsonb),
  ('node_already_set',  'runpod', '[{"provider":"runpod","provider_id":"rp-2"}]'::jsonb);

-- vps_hubs: a '' blank, a NULL blank, and an already-correct row.
insert into public.vps_hubs (tag, provider) values
  ('hub_blank_empty', ''),
  ('hub_blank_null',  null),
  ('hub_already_set', 'hetzner');
