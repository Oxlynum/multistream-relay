import { cn } from '@/lib/utils'

// achievement_key values are a backend contract (achievements.achievement_key) — do
// not rename. Labels/rewards are display copy.
const ACHIEVEMENTS = [
  { key: 'first_stream', label: 'First stream', reward: '+0.5 tkn' },
  { key: 'streak_7', label: 'Stream 7 days in a row', reward: '+1 tkn' },
  { key: 'all_5_platforms', label: 'All 5 platforms live at once', reward: '+1 tkn' },
  { key: 'milestone_30d', label: '30-day milestone', reward: '+1 tkn' },
]

/** Achievements list — earned vs locked. */
export function AchievementGrid({ earnedKeys }: { earnedKeys: string[] }) {
  return (
    <div>
      <div className="mb-3 font-pixel text-[0.6rem] uppercase text-ink-muted">Achievements</div>
      <div className="space-y-2">
        {ACHIEVEMENTS.map((a) => {
          const earned = earnedKeys.includes(a.key)
          return (
            <div
              key={a.key}
              className={cn(
                'flex items-center justify-between border-2 px-4 py-3',
                earned ? 'border-line bg-surface' : 'border-line/50 bg-surface-2/40',
              )}
            >
              <div className="flex items-center gap-3">
                <span className={cn('text-lg leading-none', earned ? 'text-success' : 'text-ink-faint opacity-40')}>
                  {earned ? '★' : '☆'}
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className={cn('text-sm', earned ? 'text-ink' : 'text-ink-faint')}>{a.label}</span>
                  <span className={cn('font-pixel text-[7px] uppercase', earned ? 'text-success' : 'text-ink-faint/60')}>
                    {earned ? 'Unlocked' : 'Locked'}
                  </span>
                </div>
              </div>
              <span className={cn('font-mono text-sm', earned ? 'text-success' : 'text-ink-faint')}>
                {a.reward}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
