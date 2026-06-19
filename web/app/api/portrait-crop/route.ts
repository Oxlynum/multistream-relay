import { createServerClient } from '@/lib/supabase'

// Per-account vertical (9:16) framing. The GPU crops the landscape source once
// using these values and fans the cropped feed out to every portrait platform.

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

async function getUser(request: Request) {
  const supabase = createServerClient()
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  return { supabase, user }
}

export async function GET(request: Request) {
  const { supabase, user } = await getUser(request)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('profiles')
    .select('portrait_zoom, portrait_pos_x, portrait_pos_y')
    .eq('id', user.id)
    .single()

  return Response.json({
    zoom: data?.portrait_zoom ?? 1.0,
    pos_x: data?.portrait_pos_x ?? 0.5,
    pos_y: data?.portrait_pos_y ?? 0.5,
  })
}

export async function PATCH(request: Request) {
  const { supabase, user } = await getUser(request)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as {
    zoom?: number; pos_x?: number; pos_y?: number
  }

  const updates: Record<string, number> = {}
  if (body.zoom !== undefined)  updates.portrait_zoom  = clamp(Number(body.zoom), 1.0, 3.0)
  if (body.pos_x !== undefined) updates.portrait_pos_x = clamp(Number(body.pos_x), 0.0, 1.0)
  if (body.pos_y !== undefined) updates.portrait_pos_y = clamp(Number(body.pos_y), 0.0, 1.0)

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true, ...updates })
}
