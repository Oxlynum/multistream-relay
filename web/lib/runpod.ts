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

// Fetch the set of datacenter IDs RunPod currently accepts for pod creation.
// Returns null on any failure so the caller can fall back gracefully.
export async function fetchDatacenterIds(): Promise<Set<string> | null> {
  try {
    const data = await gqlRequest<{ dataCenters: Array<{ id: string }> }>(
      'query { dataCenters { id } }'
    )
    const ids = (data.dataCenters ?? []).map(dc => dc.id).filter(Boolean)
    return ids.length > 0 ? new Set(ids) : null
  } catch {
    return null
  }
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
