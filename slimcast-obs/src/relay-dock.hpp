#pragma once
#include <QDockWidget>
#include <QLabel>
#include <QLineEdit>
#include <QCheckBox>
#include <QSlider>
#include <QStackedWidget>
#include <QTimer>
#include <QMap>
#include <QWidget>
#include <QPushButton>
#include "relay-api.hpp"

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
class RelayDock : public QDockWidget {
    Q_OBJECT

public:
    explicit RelayDock(QWidget *parent = nullptr);

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
    void onGpuDestroyed();
    void onPlatformsUpdated(QList<PlatformConfig> platforms);
    void onEncodeUpdated(EncodeConfig encode);
    void onNetworkError(QString message);
    void onPollTick();
    void onChannelToggled(const QString &platform, bool enabled);
    void onLockToggled(bool locked);
    void onBitrateReleased();
    void onConfirmClicked();
    void onPointObsClicked();

private:
    void buildUi();
    QWidget *buildSetupPage();
    QWidget *buildActivePage();
    void loadSettings();
    void saveSettings();
    void enterActive();   // switch to the active page + start polling
    void applyObsStreamUrl(const QString &rtmpUrl);
    void setSlimcastService(const QString &server, const QString &key);
    void ensureCustomService();
    void render(const GpuInfo &info);
    void renderConfirm(const GpuInfo &info);
    void renderServiceBanner();
    QString obsServiceIssue();
    void renderChannels();
    void updateIngestLabel();
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
    QMap<QString, ChannelRow> m_channels;
    QCheckBox      *m_lockCheck    = nullptr;
    QSlider        *m_landscapeSlider = nullptr;
    QLabel         *m_landscapeVal    = nullptr;
    QSlider        *m_portraitSlider  = nullptr;
    QLabel         *m_portraitVal     = nullptr;
    QLabel         *m_totalLabel   = nullptr;
    QLabel         *m_helperLabel  = nullptr;
    QWidget        *m_confirmBanner = nullptr;
    QLabel         *m_confirmLabel  = nullptr;
    QPushButton    *m_confirmBtn    = nullptr;
    QLabel         *m_serviceWarn   = nullptr;   // red "!" (hover): OBS not pointed at SlimCast
    QPushButton    *m_pointObsBtn   = nullptr;   // manual "point OBS at SlimCast"

    // ── Internal state ─────────────────────────────────────────────────────
    RelayApi *m_api;
    QTimer   *m_pollTimer;

    bool m_autoLaunching  = false;
    bool m_resumingStream = false;
    bool m_wasStreaming   = false;  // to auto-engage the channel lock on stream start
    bool m_haveEncode     = false;
    int  m_orphanTicks    = 0;      // consecutive polls of "pod up, OBS not streaming"

    GpuInfo                   m_lastGpuInfo;
    QMap<QString, PlatformConfig> m_platforms;  // platform -> current config
    EncodeConfig              m_encode;
};
