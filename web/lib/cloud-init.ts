// cloud-init.ts — builds the #cloud-config user_data that a fresh VPS runs on
// first boot to become a SlimCast relay node.
//
// It installs Docker and launches the SAME relay image we run on GPU pods, but
// with RELAY_ROLE=vps (CPU-only: SRT ingest + passthrough delivery + — for
// transcode — source-forward to a GPU and platform fan-out). No NVIDIA runtime is
// requested (a Hetzner CPU box has no GPU; the relay's role branch skips the GPU
// self-test on RELAY_ROLE=vps).
//
// CONSTRAINTS:
//  - Hetzner caps user_data at 32 KiB. Keep this lean — pull the image, don't
//    build. (If cloud-init docker-pull risks the readiness window, Phase 4 swaps
//    to a prebuilt Hetzner snapshot; this file stays the source of truth either way.)
//  - VPS ports are FIXED (container port == host == public). We bind the relay's
//    ports directly with -p; there is no provider port remap to discover.
//  - This is Phase-0 scaffolding: it produces a valid cloud-config the broker can
//    hand to HetznerProvider.create(). It is not wired into provision() until the
//    SLIMCAST_VPS_HUB flag flips on.

export interface CloudInitOpts {
  imageTag: string                 // ghcr.io/oxlynum/multistream-relay:<sha>
  role: 'vps' | 'gpu'              // RELAY_ROLE for this box
  env: Record<string, string>      // SLIMCAST_API_KEY, SLIMCAST_INGEST_KEY, ports, etc.
  imageLogin?: {                   // private-registry creds (ghcr) — optional
    server: string                 // 'ghcr.io'
    username: string
    password: string               // a token, NOT a real password
  }
  // Published ports for the relay role. Hetzner has no remap, so host==container.
  //   vps: SRT ingest (udp), RTMP beacon (tcp), bridge-return (tcp), HLS (tcp, off by default)
  //   gpu: bridge-in (tcp), return-out is an OUTBOUND push (no inbound port)
  ports: Array<{ host: number; container: number; proto: 'tcp' | 'udp' }>
}

// Shell-quote a value for safe inclusion in a docker `-e KEY=VALUE` arg inside a
// double-quoted runcmd string. Hetzner runs runcmd via /bin/sh; we wrap the whole
// docker run in single quotes at the call site, so single quotes in values are the
// only hazard — escape them the POSIX way ('\'').
function sq(v: string): string {
  return v.replace(/'/g, `'\\''`)
}

export function buildCloudInit(opts: CloudInitOpts): string {
  const { imageTag, role, env, imageLogin, ports } = opts

  const envFlags = Object.entries(env)
    .map(([k, v]) => `-e '${sq(k)}=${sq(v)}'`)
    .join(' ')

  const portFlags = ports
    .map(p => `-p ${p.host}:${p.container}/${p.proto}`)
    .join(' ')

  const loginCmd = imageLogin
    ? `docker login ${sq(imageLogin.server)} -u '${sq(imageLogin.username)}' -p '${sq(imageLogin.password)}'`
    : `: # public image, no login`

  // RELAY_ROLE is passed explicitly; the relay defaults to all-in-one if unset, so
  // we never want to rely on the default here.
  const runRelay =
    `docker run -d --name slimcast-relay --restart unless-stopped ` +
    `${portFlags} ` +
    `-e 'RELAY_ROLE=${sq(role)}' ${envFlags} ` +
    `${sq(imageTag)}`

  // YAML #cloud-config. runcmd executes after package install. We install Docker
  // from Ubuntu's repo (fast, no external script) — adequate for Phase 0; a
  // prebuilt snapshot (Phase 4) removes this latency entirely.
  return [
    `#cloud-config`,
    `package_update: true`,
    `packages:`,
    `  - docker.io`,
    `runcmd:`,
    `  - systemctl enable --now docker`,
    `  - ${loginCmd}`,
    `  - docker pull ${sq(imageTag)}`,
    `  - ${runRelay}`,
    ``,
  ].join('\n')
}
