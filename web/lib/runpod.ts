const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!
// RunPod's REST API is v1 (https://rest.runpod.io/v1). The old /v2 path returns
// an HTML page → "Unexpected token '<'" when parsed as JSON.
const BASE = 'https://rest.runpod.io/v1'

interface RunPodPod {
  id: string
  name: string
  desiredStatus: string
  costPerHr?: number
}

interface GqlPod {
  id: string
  desiredStatus: string
  machine?: { dataCenterId?: string | null }
  runtime?: {
    ports?: Array<{ ip: string; isIpPublic: boolean; privatePort: number; publicPort: number }>
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`RunPod ${method} ${path} → ${res.status}: ${text.slice(0, 800)}`)
  }
  if (!text) return undefined as T   // e.g. DELETE returns empty
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`RunPod ${method} ${path} → ${res.status} non-JSON body: ${text.slice(0, 200)}`)
  }
}

// RunPod's v1 REST API doesn't return port mappings (portMappings and
// runtime.ports are both absent). Use the GraphQL API for status polling —
// it reliably includes runtime.ports once the container is up.
async function gqlRequest<T>(query: string): Promise<T> {
  const res = await fetch(`https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.json() as { data?: T; errors?: Array<{ message: string }> }
  if (body.errors?.length) {
    throw new Error(`RunPod GraphQL: ${body.errors[0].message}`)
  }
  if (!body.data) throw new Error('RunPod GraphQL: empty response')
  return body.data
}

// Sentinel stored for a GPU that RunPod lists but reports zero inventory for.
// RunPod signals out-of-stock by returning the GPU with stockStatus: null (NOT a
// "None" string and NOT by omitting it), so we record an explicit marker the
// broker can skip on. In-stock GPUs map to 'High' | 'Medium' | 'Low'.
export const STOCK_NONE = 'None'

// Preflight inventory check. Asks RunPod (one GraphQL call per cloud tier) for
// the current stock level of every GPU type, so the broker can SKIP combos with
// zero inventory instead of discovering it the slow way — a sequential failed
// create() per dead combo. Returns a map keyed `${gpuId}|${cloudType}` →
// stockStatus ('High'|'Medium'|'Low'|STOCK_NONE).
//
// Two layers of fail-open keep a flaky/empty stock query from ever blocking a
// stream: (1) a cloud tier whose query throws contributes NO entries, so every
// GPU in it is "unknown" and gets tried; (2) a GPU id RunPod doesn't return at
// all stays absent → also tried. Only an explicit present-but-null (STOCK_NONE)
// is treated as "skip". The broker additionally falls back to the unfiltered
// list if stock filtering would drop every candidate.
export async function fetchGpuStock(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  // cloudType string (as used in candidates) → secureCloud bool (query input).
  const tiers: Array<[string, boolean]> = [['COMMUNITY', false], ['SECURE', true]]
  for (const [cloudType, secure] of tiers) {
    try {
      const data = await gqlRequest<{ gpuTypes: Array<{ id: string; lowestPrice: { stockStatus: string | null } | null }> }>(
        `query { gpuTypes { id lowestPrice(input: {gpuCount: 1, secureCloud: ${secure}}) { stockStatus } } }`
      )
      for (const g of data.gpuTypes ?? []) {
        if (!g.id) continue
        // present-but-null stockStatus = out of stock → record the sentinel.
        out.set(`${g.id}|${cloudType}`, g.lowestPrice?.stockStatus ?? STOCK_NONE)
      }
    } catch {
      // leave this tier's entries absent → broker treats it as unknown and tries it
    }
  }
  return out
}

export interface PodEnv { key: string; value: string }

// Low-level pod create for one specific candidate (gpu type + cloud + DC).
// The broker (lib/gpu-broker.ts) calls this repeatedly down a priority list and
// catches "no capacity" errors to cascade — so this throws on any failure.
export async function createPod(params: {
  name: string
  imageTag: string
  env: PodEnv[]
  gpuTypeId: string
  cloudType?: string
  dataCenterIds?: string[]
}): Promise<{ podId: string; costPerHr?: number }> {
  const pod = await request<RunPodPod>('POST', '/pods', {
    name: params.name,
    imageName: params.imageTag,
    gpuTypeIds: [params.gpuTypeId],
    cloudType: params.cloudType ?? 'COMMUNITY',
    containerDiskInGb: 15,
    // 1935 = RTMP ingest (OBS → pod). 8888 = MediaMTX HLS preview.
    // v1 REST: ports is an array, not a string.
    ports: ['1935/tcp', '8888/tcp'],
    // v1 REST: env is a plain object { KEY: value }, not [{key, value}] (GraphQL shape).
    env: Object.fromEntries(params.env.map(e => [e.key, e.value])),
    // dataCenterIds (plural array) is the correct v1 REST field name.
    ...(params.dataCenterIds?.length ? { dataCenterIds: params.dataCenterIds } : {}),
  })
  return { podId: pod.id, costPerHr: pod.costPerHr }
}

export async function stopPod(podId: string): Promise<void> {
  await request('POST', `/pods/${podId}/stop`)
}

export async function startPod(podId: string): Promise<void> {
  await request('POST', `/pods/${podId}/start`)
}

export async function destroyPod(podId: string): Promise<void> {
  await request('DELETE', `/pods/${podId}`)
}

// List all pods on the account (used by the reaper to find orphans).
export async function listPods(): Promise<Array<{ id: string; name: string }>> {
  const pods = await request<RunPodPod[]>('GET', '/pods')
  return (pods ?? []).map(p => ({ id: p.id, name: p.name }))
}

// Poll pod status via GraphQL — the only RunPod API path that reliably returns
// runtime.ports (public IP + mapped port) for community cloud pods.
// The v1 REST GET /pods/{id} response omits portMappings/runtime for community
// pods, so we'd time out waiting for a port that never appears there.
export async function getPodStatus(podId: string): Promise<{ status: string; ip: string | null; port: number | null; hlsPort: number | null; dataCenterId: string | null }> {
  const data = await gqlRequest<{ pod: GqlPod }>(
    `query { pod(input: {podId: "${podId}"}) { id desiredStatus machine { dataCenterId } runtime { ports { ip isIpPublic privatePort publicPort } } } }`
  )
  const pod = data.pod
  const ports = pod?.runtime?.ports ?? []
  const rtmpObj = ports.find(p => p.isIpPublic && p.privatePort === 1935)
  const hlsObj  = ports.find(p => p.isIpPublic && p.privatePort === 8888)

  const ip           = rtmpObj?.ip ?? null
  const port         = rtmpObj?.publicPort ?? null
  const hlsPort      = hlsObj?.publicPort ?? null
  const dataCenterId = pod?.machine?.dataCenterId ?? null

  console.log(`[runpod/gql] pod ${podId} status=${pod?.desiredStatus} dc=${dataCenterId} ip=${ip} rtmp=${port} hls=${hlsPort}`)

  return {
    status: pod?.desiredStatus ?? 'unknown',
    ip,
    port,
    hlsPort,
    dataCenterId,
  }
}
