import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, TIER_LIMITS } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')
  if (!key) {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 })
  }

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('license_keys')
    .select('tier, active')
    .eq('key', key)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 404 })
  }

  if (!data.active) {
    return NextResponse.json({ error: 'Key deactivated' }, { status: 403 })
  }

  // Update last_validated_at without blocking the response
  supabase
    .from('license_keys')
    .update({ last_validated_at: new Date().toISOString() })
    .eq('key', key)
    .then(() => {})

  return NextResponse.json(TIER_LIMITS[data.tier as 'free' | 'pro'])
}
