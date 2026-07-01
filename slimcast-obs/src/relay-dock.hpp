#pragma once
#include <QWidget>
#include <QLabel>
#include <QLineEdit>
#include <QCheckBox>
#include <QSpinBox>
#include <QStackedWidget>
#include <QTimer>
#include <QMap>
#include <QWidget>
#include <QPushButton>
#include "relay-api.hpp"
#include "HealthGraphWidget.h"

// One channel control row: live dot + name + cost sub-line + on/off toggle.
struct ChannelRow {
    QWidget   *container = nullptr;
    QLabel    *dot       = nullptr;
    QLabel    *name      = nullptr;
    QLabel    *sub       = nullptr;  // faint: "live · +0.2 tkn/hr" / "off"
    QCheckBox *toggle    = nullptr;
};

// A single status + control dock. GPU start/stop is 100% OBS-driven (no manual
// GPU controls). What the user *can* do here — toggle channels on/off, set the
// per-group bitrate cap — writes the same Supabase config the website does, so
// the dock and slimcast.com always stay in sync. Resolution + frame rate are
// owned by OBS and shown read-only.
class RelayDock : public QWidget {
    Q_OBJECT

public:
    explicit RelayDock(QWidget *parent = nullptr);
    void setObsStreamBtn(QPushButton *btn);

public slots:
    // Invoked via QMetaObject::invokeMethod from OBS frontend-event callback.
    void onObsStreamingStarting();
    void onObsStreamingStopped();

private slots:
    void onSaveApiKey();
    void onConnectClicked();
    void onDisconnect();
    void onDeviceLinked(QString apiKey);
    void onDeviceLinkFailed(QString message);
    void onGpuStatusUpdated(GpuInfo info);
    void onGpuProvisioned();
    void onGpuProvisionFailed(QString reason);
    void onGpuDestroyed();
    void onPlatformsUpdated(QList<PlatformConfig> platforms);
    void onEncodeUpdated(EncodeConfig encode);
    void onNetworkError(QString message);
    void onPollTick();
    void onChannelToggled(const QString &platform, bool enabled);
    void onLockToggled(bool locked);
    void onBitrateReleased();
    void onConfirmClicked();
    void onGoLiveClicked();
    void onMainBtnClicked();   // dispatches: Go Live | Cancel | Stop Stream
    void onAutoConfigure();    // detect HEVC encoder + apply SlimCast OBS settings

private:
    void buildUi();
    QWidget *buildSetupPage();
    QWidget *buildStreamTab();
    QWidget *buildOutputsTab();
    QWidget *buildSlimSyncTab();
    void loadSettings();
    void saveSettings();
    void enterActive();   // switch to the active page + start polling
    void abortLaunch(const QString &message);   // give up + clean up a failed Go Live
    // REL-01 shared-hub failover: the server flipped this tenant to status=='error' (its
    // hub was hard-destroyed / a provision failed). Stop OBS cleanly so it stops pushing to
    // the dead hub IP, then auto-reconnect onto a fresh hub (bounded retries).
    void handleServerLost();
    void applyObsStreamUrl(const QString &server, const QString &key);
    void setSlimcastService(const QString &server, const QString &key);
    // Write SlimCast's recommended encoder settings into the active OBS profile.
    void applyRecommendedSettings(const QString &encId, int bframeFamily, int bitrate);
    // Budget throttle: lower the LIVE stream encoder's bitrate mid-stream when the
    // pod signals it's approaching the cost ceiling. Distinct from
    // applyRecommendedSettings (which writes a JSON profile for pre-stream setup).
    void applyIngestThrottle(int kbps);

    bool eventFilter(QObject *obj, QEvent *event) override;
    void restoreObsStreamBtn();   // snap back to OBS's saved style/text immediately

    void render(const GpuInfo &info);
    void renderConfirm(const GpuInfo &info);
    void renderServiceBanner();
    QString obsServiceIssue();
    void renderChannels();
    void updateIngestLabel();
    // Go-Live gate: a >1080p OBS output on a non-2K account would cost upload + GPU
    // decode without ever reaching a platform at 2K. One window — offer to downscale
    // ("b") or upgrade; declining blocks the launch ("a"). Returns true to proceed.
    bool passes2kGate();
    // Pin OBS's scaled output resolution to 1080p (preserving aspect + base canvas).
    bool downscaleOutputTo1080();
    void updateTotals();
    void setStatus(const QString &text, const QString &color);
    void showSetup(bool setup);

    // ── Setup page ─────────────────────────────────────────────────────────
    QLineEdit *m_apiKeyEdit = nullptr;
    QLabel    *m_setupHint  = nullptr;   // link status / error under the buttons

    // ── Active page ────────────────────────────────────────────────────────
    QStackedWidget *m_pages        = nullptr;
    QLabel         *m_statusDot    = nullptr;
    QLabel         *m_statusLabel  = nullptr;
    QLabel         *m_creditsLabel = nullptr;
    QLabel         *m_ingestLabel  = nullptr;
    QPushButton    *m_goLiveBtn    = nullptr;   // hidden; kept for render() state logic
    QPushButton    *m_obsStreamBtn = nullptr;   // native OBS "Start Streaming" button
    QString         m_obsStreamBtnSavedStyle;
    QString         m_obsStreamBtnSavedText;
    bool            m_obsStreamBtnOverridden = false;
    QMap<QString, ChannelRow> m_channels;
    QCheckBox      *m_lockCheck    = nullptr;
    QSpinBox       *m_landscapeSpin   = nullptr;
    QSpinBox       *m_portraitSpin    = nullptr;
    QLabel         *m_totalLabel   = nullptr;
    QLabel         *m_helperLabel  = nullptr;
    QWidget        *m_confirmBanner = nullptr;
    QLabel         *m_confirmLabel  = nullptr;
    QPushButton    *m_confirmBtn    = nullptr;
    QPushButton    *m_serviceWarn   = nullptr;   // red "⚠" (hover/click): OBS drifted off SlimCast

    // ── Internal state ─────────────────────────────────────────────────────
    // Health tab
    HealthGraphWidget *m_healthWidget = nullptr;

    RelayApi *m_api;
    QTimer   *m_pollTimer;
    QTimer   *m_launchTimeout   = nullptr;   // overall Go Live timeout
    QTimer   *m_streamWatchdog  = nullptr;   // 90s platform-alive check after OBS starts

    bool m_autoLaunching  = false;
    bool m_resumingStream = false;
    bool m_shuttingDown   = false;   // stop/destroy in progress
    qint64 m_launchStartMs = 0;      // when Go Live was pressed (for elapsed time)
    bool m_wasStreaming   = false;  // to auto-engage the channel lock on stream start
    bool m_haveEncode     = false;
    bool m_has2kAddon     = false;  // account 2K entitlement (from /api/gpu/status) — gates the resolution warning
    bool m_statusKnown    = false;  // a /api/gpu/status response has landed → m_has2kAddon is trustworthy
    int  m_orphanTicks    = 0;      // consecutive polls of "pod up, OBS not streaming"
    int    m_failoverCount = 0;         // REL-01: auto-reconnects used in the current rolling window
    qint64 m_failoverWindowStartMs = 0; // REL-01: start of the rolling failover-count window (0 = none yet)
    bool m_serverLostHandled = false;   // REL-01: latch so a sustained run of status=='error' polls fires failover ONCE per episode
    bool m_failoverPending = false;     // REL-01: a reconnect singleShot is armed — suppress the stop-handler's destroy + "Stopping…" overwrite
    int  m_appliedThrottleKbps = 0; // last throttle bitrate we pushed (0 = none/unthrottled)
    int  m_originalBitrateKbps = 0; // user's configured bitrate, captured before first throttle

    GpuInfo                   m_lastGpuInfo;
    QMap<QString, PlatformConfig> m_platforms;  // platform -> current config
    EncodeConfig              m_encode;
};
