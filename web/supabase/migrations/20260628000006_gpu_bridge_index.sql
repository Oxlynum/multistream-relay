-- VPS-Hub Phase 2 (P2): index for the gpu-backend key-auth path.
-- authenticateNode('gpu') resolves a gpu_backend relay_nodes row by node_key_hash on every
-- GPU heartbeat / gpu-config poll. The Phase-0 migration indexed instance/user/provider but
-- not node_key_hash, which is the hot lookup column. Additive; inert until the bridge is live.
-- Deploy with: supabase db push

create index if not exists relay_nodes_node_key_hash_idx on public.relay_nodes (node_key_hash);
