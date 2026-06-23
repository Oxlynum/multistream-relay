const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!
const BASE = 'https://rest.runpod.io/v2'

interface RunPodPod {
  id: string
  name: string
  desiredStatus: string
  costPerHr?: number
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
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`RunPod ${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
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
  const registryAuthId = process.env.RUNPOD_REGISTRY_AUTH_ID

  const pod = await request<RunPodPod>('POST', '/pods', {
    name: params.name,
    imageName: params.imageTag,
    gpuTypeId: params.gpuTypeId,
    cloudType: params.cloudType ?? 'COMMUNITY',
    containerDiskInGb: 15,
    volumeInGb: 0,
    // Only expose the RTMP ingest publicly. The FastAPI debug panel on :8080
    // handles stream keys and must never be reachable from the internet — the
    // agent talks to Vercel, nothing external talks to the pod except OBS→RTMP.
    ports: '1935/tcp',
    env: params.env,
    // Restrict to the supplied datacenters (proximity-ordered by the broker).
    ...(params.dataCenterIds?.length ? { dataCenterIds: params.dataCenterIds } : {}),
    ...(registryAuthId ? { containerRegistryAuthId: registryAuthId } : {}),
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
