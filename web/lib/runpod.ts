const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!
// RunPod's REST API is v1 (https://rest.runpod.io/v1). The old /v2 path returns
// an HTML page → "Unexpected token '<'" when parsed as JSON.
const BASE = 'https://rest.runpod.io/v1'

interface RunPodPod {
  id: string
  name: string
  desiredStatus: string
  costPerHr?: number
  publicIp?: string
  // v1 may expose the mapped public port via portMappings { "1935": 12345 } or
  // the older runtime.ports[] shape. We handle both in getPodStatus.
  portMappings?: Record<string, number>
  runtime?: { ports?: Array<{ ip: string; isIpPublic: boolean; privatePort: number; publicPort: number }> }
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

export interface PodEnv { key: string; value: string }

// Low-level pod create for one specific candidate (gpu type + cloud + DC list).
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
    gpuTypeId: params.gpuTypeId,
    cloudType: params.cloudType ?? 'COMMUNITY',
    containerDiskInGb: 15,
    // No persistent volume needed — the pod is ephemeral (destroyed on stream stop).
    // v1 REST: ports is an array, not a string.
    ports: ['1935/tcp'],
    // v1 REST: env is a plain object { KEY: value }, not [{key, value}] (GraphQL shape).
    env: Object.fromEntries(params.env.map(e => [e.key, e.value])),
    // Datacenter selection via v1 REST is not supported (GraphQL-only).
    // Let RunPod auto-select within the requested cloudType.
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

// List all pods on the account (used by the reaper to find orphans — pods that
// exist at RunPod but have no gpu_instances row, which no other path can see).
export async function listPods(): Promise<Array<{ id: string; name: string }>> {
  const pods = await request<RunPodPod[]>('GET', '/pods')
  return (pods ?? []).map(p => ({ id: p.id, name: p.name }))
}

export async function getPodStatus(podId: string): Promise<{ status: string; ip: string | null; port: number | null }> {
  const pod = await request<RunPodPod>('GET', `/pods/${podId}`)
  // RunPod proxies the internal 1935/tcp to a public IP + a RANDOM external
  // port. OBS must use that mapped port, not 1935.
  const publicPort = pod.runtime?.ports?.find(p => p.isIpPublic && p.privatePort === 1935)
  return {
    status: pod.desiredStatus,
    ip: publicPort?.ip ?? null,
    port: publicPort?.publicPort ?? null,
  }
}
