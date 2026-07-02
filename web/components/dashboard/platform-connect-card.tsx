'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PlatformIcon, PLATFORM_META, type PlatformKey } from '@/components/platform-icon'
import { cn } from '@/lib/utils'

export interface PlatformConnectCardProps {
  id: PlatformKey
  label: string
  note: string | null
  connected: boolean
  enabled: boolean
  isOAuthPlatform: boolean
  isOAuthConnected: boolean
  comingSoon?: boolean
  streamKey: string
  connecting: boolean
  saving: boolean
  saved: boolean
  removing: boolean
  onStreamKeyChange: (v: string) => void
  onToggleEnabled: (enabled: boolean) => void
  onConnectOAuth: () => void
  onDisconnectOAuth: () => void
  onSave: () => void
  onRemove: () => void
}

export function PlatformConnectCard({
  id,
  label,
  note,
  connected,
  enabled,
  isOAuthPlatform,
  isOAuthConnected,
  comingSoon,
  streamKey,
  connecting,
  saving,
  saved,
  removing,
  onStreamKeyChange,
  onToggleEnabled,
  onConnectOAuth,
  onDisconnectOAuth,
  onSave,
  onRemove,
}: PlatformConnectCardProps) {
  const tint = PLATFORM_META[id]?.tint
  return (
    <Card className="border-line">
      <CardContent className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border"
              style={{ borderColor: `${tint}40`, color: tint, background: `${tint}14` }}
            >
              <PlatformIcon platform={id} className="h-5 w-5" />
            </span>
            <div>
              <div className="font-display font-semibold text-ink">{label}</div>
              {connected && (
                <Badge
                  variant="outline"
                  className="mt-0.5 border-success/40 bg-success/10 text-success"
                >
                  {isOAuthConnected ? 'Connected via OAuth' : 'Connected'}
                </Badge>
              )}
            </div>
          </div>
          {connected && (
            <label className="flex cursor-pointer items-center gap-2">
              <span className="text-xs text-ink-muted">Active</span>
              <Switch checked={enabled} onCheckedChange={onToggleEnabled} />
            </label>
          )}
        </div>

        {note && <p className="text-xs leading-relaxed text-ink-faint">{note}</p>}

        {/* OAuth connect */}
        {isOAuthPlatform && (
          <div>
            {isOAuthConnected ? (
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink-muted">Stream key fetched automatically</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDisconnectOAuth}
                  disabled={removing}
                  className="text-danger hover:text-danger"
                >
                  {removing ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </div>
            ) : comingSoon ? (
              <Button
                disabled
                className="h-9 w-full"
              >
                {label} (coming soon)
              </Button>
            ) : (
              <Button
                onClick={onConnectOAuth}
                disabled={connecting}
                className="h-9 w-full"
              >
                {connecting ? 'Redirecting…' : `Connect with ${label}`}
              </Button>
            )}
          </div>
        )}

        {/* Manual stream key */}
        <div>
          <div className="mb-1.5 text-xs text-ink-faint">
            {isOAuthPlatform
              ? isOAuthConnected
                ? 'Or override with a manual stream key'
                : 'Or paste stream key manually'
              : 'Stream key'}
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder={connected ? '••••••••••••••••' : 'Paste your stream key'}
              value={streamKey}
              onChange={(e) => onStreamKeyChange(e.target.value)}
              className="h-9 flex-1 font-mono"
            />
            <Button
              variant="outline"
              onClick={onSave}
              disabled={saving || !streamKey.trim()}
              className={cn('h-9 min-w-[72px]', saved && 'border-success/50 text-success')}
            >
              {saving ? '…' : saved ? 'Saved!' : connected ? 'Update' : 'Save'}
            </Button>
          </div>
        </div>

        {/* Manual-only remove */}
        {connected && !isOAuthConnected && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={removing}
            className="text-danger hover:text-danger"
          >
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
