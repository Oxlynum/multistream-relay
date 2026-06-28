// RunPod REST + GraphQL API layer (recovered from git 070ed53^ and adapted for the
// VPS-hub GPU BACKEND role). RunPod was removed when ingest required SRT/UDP (RunPod
// is TCP-only). The VPS-hub bridge is mpegts-over-TCP, so RunPod is viable again as a
// GPU backend — and we NEED it: Vast's catalog is too limited (the whole reason for
// the hub). RunPod is never an OBS-ingest pod; it only ever receives the bridge.

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY
const BASE = 'https://rest.runpod.io/v1'

// The GPU backend's bridge-in TCP port (VPS pushes mpegts-over-TLS here). Mirrors
// relay/Dockerfile EXPOSE 8899 and the Vast/relay constant.
export const BRIDGE_IN_PORT = 8899

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
    headers: { Authorization: `Bearer ${RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`RunPod ${method} ${path} → ${res.status}: ${text.slice(0, 800)}`)
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`RunPod ${method} ${path} → ${res.status} non-JSON body: ${text.slice(0, 200)}`)
  }
}

// v1 REST omits port mappings for some pods; GraphQL reliably returns runtime.ports.
async function gqlRequest<T>(query: string): Promise<T> {
  const res = await fetch(`https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (body.errors?.length) throw new Error(`RunPod GraphQL: ${body.errors[0].message}`)
  if (!body.data) throw new Error('RunPod GraphQL: empty response')
  return body.data
}

export interface PodEnv { key: string; value: string }

export async function createPod(params: {
  name: string
  imageTag: string
  env: PodEnv[]
  gpuTypeId: string
  cloudType?: string
  dataCenterIds?: string[]
  ports?: string[]
}): Promise<{ podId: string; costPerHr?: number }> {
  const pod = await request<RunPodPod>('POST', '/pods', {
    name: params.name,
    imageName: params.imageTag,
    gpuTypeIds: [params.gpuTypeId],
    cloudType: params.cloudType ?? 'SECURE',
    containerDiskInGb: 15,
    // Backend role: ONLY the bridge-in TCP port (the GPU has no MediaMTX / no RTMP
    // ingest). Defaults to the bridge port; the RTMPS return is OUTBOUND (no inbound
    // port needed for it).
    ports: params.ports ?? [`${BRIDGE_IN_PORT}/tcp`],
    env: Object.fromEntries(params.env.map(e => [e.key, e.value])),
    ...(params.dataCenterIds?.length ? { dataCenterIds: params.dataCenterIds } : {}),
  })
  return { podId: pod.id, costPerHr: pod.costPerHr }
}

export async function stopPod(podId: string): Promise<void> {
  await request('POST', `/pods/${podId}/stop`)
}

export async function destroyPod(podId: string): Promise<void> {
  await request('DELETE', `/pods/${podId}`)
}

export async function listPods(): Promise<Array<{ id: string; name: string }>> {
  const pods = await request<RunPodPod[]>('GET', '/pods')
  return (pods ?? []).map(p => ({ id: p.id, name: p.name }))
}

// PodStatus-compatible (lib/providers/types.ts). For the backend role the meaningful
// public port is the BRIDGE-IN (8899); `port` carries it (falling back to any 1935).
// srtPort is intentionally null — a bridge GPU has no SRT ingest.
export async function getPodStatus(podId: string): Promise<{
  status: string; ip: string | null; port: number | null; hlsPort: number | null
  dataCenterId: string | null; srtPort: number | null
}> {
  const data = await gqlRequest<{ pod: GqlPod }>(
    `query { pod(input: {podId: "${podId}"}) { id desiredStatus machine { dataCenterId } runtime { ports { ip isIpPublic privatePort publicPort } } } }`,
  )
  const pod = data.pod
  const ports = pod?.runtime?.ports ?? []
  const bridgeObj = ports.find(p => p.isIpPublic && p.privatePort === BRIDGE_IN_PORT)
    ?? ports.find(p => p.isIpPublic && p.privatePort === 1935)
  return {
    status: pod?.desiredStatus ?? 'unknown',
    ip: bridgeObj?.ip ?? null,
    port: bridgeObj?.publicPort ?? null,   // the mapped bridge-in TCP port
    hlsPort: null,
    dataCenterId: pod?.machine?.dataCenterId ?? null,
    srtPort: null,
  }
}
