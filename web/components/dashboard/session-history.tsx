import { formatTokens } from '@/lib/billing'

export interface StreamSession {
  id: string
  started_at: string
  duration_seconds: number | null
  credits_deducted: number | null
  platforms: string[]
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Last-20 stream sessions table. */
export function SessionHistory({ sessions }: { sessions: StreamSession[] }) {
  if (sessions.length === 0) return null

  return (
    <div>
      <div className="mb-3 text-sm text-ink-muted">Stream history</div>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-ink-faint">
              <th className="px-4 py-3 text-left font-normal">Date</th>
              <th className="px-4 py-3 text-left font-normal">Duration</th>
              <th className="px-4 py-3 text-left font-normal">Tokens used</th>
              <th className="px-4 py-3 text-left font-normal">Platforms</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-b border-line/50 last:border-0">
                <td className="px-4 py-3 text-ink-muted">
                  {new Date(s.started_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 font-mono text-ink-muted">
                  {formatDuration(s.duration_seconds)}
                </td>
                <td className="px-4 py-3 font-mono text-ink-muted">
                  {formatTokens(s.credits_deducted ?? 0)}
                </td>
                <td className="px-4 py-3 text-xs text-ink-faint capitalize">
                  {s.platforms?.join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
