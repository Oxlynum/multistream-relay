#pragma once
#include <QDockWidget>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QCheckBox>
#include <QTimer>
#include <QWidget>
#include "relay-api.hpp"

// Per-platform status row in the Status tab.
struct PlatformRow {
    QLabel *dot   = nullptr;
    QLabel *label = nullptr;
};

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
    void onStartRelay();
    void onStopRelay();
    void onGpuStatusUpdated(GpuInfo info);
    void onGpuProvisioned();
    void onNetworkError(QString message);
    void onLaunchPollTick();
    void onStatusPollTick();

private:
    void buildUi();
    void loadSettings();
    void saveSettings();
    void applyObsStreamUrl(const QString &rtmpUrl);
    void setServerStatus(const QString &text, const QString &color);
    void setCreditsLabel(int seconds);

    // ── Account tab ──────────────────────────────────────────────────────────
    QLineEdit   *m_apiKeyEdit    = nullptr;
    QLabel      *m_serverStatus  = nullptr;
    QLabel      *m_creditsLabel  = nullptr;
    QPushButton *m_startBtn      = nullptr;
    QPushButton *m_stopBtn       = nullptr;

    // ── Status tab ───────────────────────────────────────────────────────────
    QMap<QString, PlatformRow> m_platformRows;
    QLabel *m_streamingLabel     = nullptr;

    // ── Bottom bar ───────────────────────────────────────────────────────────
    QCheckBox *m_autoLaunch      = nullptr;
    QLabel    *m_statusBar       = nullptr;

    // ── Internal state ───────────────────────────────────────────────────────
    RelayApi *m_api;
    QTimer   *m_launchPollTimer; // fires while GPU is provisioning
    QTimer   *m_statusPollTimer; // fires every 5s when connected

    // True while we cancelled OBS streaming to wait for GPU provisioning.
    // Prevents the automatic STREAMING_STOPPED signal from triggering a relay stop.
    bool     m_autoLaunching     = false;
    // True for one cycle after we programmatically restart OBS streaming,
    // so onObsStreamingStarting() skips the GPU check on that re-entry.
    bool     m_resumingStream    = false;

    GpuInfo  m_lastGpuInfo;
};
