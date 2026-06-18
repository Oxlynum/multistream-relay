const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!
const BASE = 'https://rest.runpod.io/v2'

interface RunPodPod {
  id: string
  name: string
  desiredStatus: string
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

export async function createPod(params: {
  name: string
  imageTag: string
  apiKey: string
  gpuTypeId?: string
}): Promise<{ podId: string }> {
  const pod = await request<RunPodPod>('POST', '/pods', {
    name: params.name,
    imageName: params.imageTag,
    gpuTypeId: params.gpuTypeId ?? 'NVIDIA GeForce RTX 4090',
    cloudType: 'SECURE',
    containerDiskInGb: 10,
    volumeInGb: 0,
    ports: '1935/tcp,8080/tcp',
    env: [{ key: 'SLIMCAST_API_KEY', value: params.apiKey }],
  })
  return { podId: pod.id }
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

export async function getPodStatus(podId: string): Promise<{ status: string; ip: string | null }> {
  const pod = await request<RunPodPod>('GET', `/pods/${podId}`)
  const publicPort = pod.runtime?.ports?.find(p => p.isIpPublic && p.privatePort === 1935)
  return {
    status: pod.desiredStatus,
    ip: publicPort?.ip ?? null,
  }
}
