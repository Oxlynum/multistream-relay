#pragma once
#include <QDockWidget>
#include <QComboBox>
#include <QLineEdit>
#include <QSpinBox>
#include <QCheckBox>
#include <QPushButton>
#include <QLabel>
#include <QPlainTextEdit>
#include <QTimer>
#include <QWidget>
#include <QJsonObject>
#include "relay-api.hpp"
#include "cloud-provider.hpp"

// Per-output status row — kept as plain pointers into the status tab's layout.
// Rebuilt only when the number of outputs changes.
struct OutputStatusRow {
    QLabel        *dot   = nullptr;
    QLabel        *state = nullptr;
    QPlainTextEdit *logs = nullptr;
};

class RelayDock : public QDockWidget {
    Q_OBJECT

public:
    explicit RelayDock(QWidget *parent = nullptr);

public slots:
    // Invoked via QMetaObject::invokeMethod from the OBS frontend-event callback.
    // Qt::QueuedConnection ensures the network POST runs on the event loop, not
    // inside OBS's callback dispatch.
    void onObsStreamingStarting();
    void onObsStreamingStopped();

private slots:
    void onProviderChanged(int index);
    void onApplyServer();
    void onSavePlatforms();
    void onStart();
    void onStop();
    void onRestart();
    void onStatusUpdated(QJsonArray outputs);
    void onConfigLoaded(QJsonObject config);
    void onApiError(QString message);
    void onCloudStart();
    void onCloudStop();
    void onCloudStatusChanged(const QString &status);
    void onCloudServerReady(ServerInfo info);

private:
    void     buildUi();
    void     loadSettings();
    void     saveSettings();
    QString  buildIngestUrl() const;
    void     applyObsStreamUrl();
    QJsonObject buildRelayConfig() const;
    void     setConnLabel(bool ok, const QString &msg = {});
    QWidget *buildStatusTab();

    // ── Server tab ──────────────────────────────────────────────────────────
    QComboBox *m_provider    = nullptr;
    QLineEdit *m_host        = nullptr;
    QSpinBox  *m_ingestPort  = nullptr;
    QSpinBox  *m_apiPort     = nullptr;
    QLineEdit *m_token       = nullptr;
    QLabel    *m_connLabel   = nullptr;

    // ── Platforms tab ───────────────────────────────────────────────────────
    QCheckBox *m_twitchEn    = nullptr;
    QLineEdit *m_twitchKey   = nullptr;
    QSpinBox  *m_twitchBr    = nullptr;
    QComboBox *m_twitchFps   = nullptr;

    QCheckBox *m_kickEn      = nullptr;
    QLineEdit *m_kickKey     = nullptr;
    QSpinBox  *m_kickBr      = nullptr;
    QComboBox *m_kickFps     = nullptr;

    QCheckBox *m_ytEn        = nullptr;
    QLineEdit *m_ytUrl       = nullptr;

    // ── Status tab ──────────────────────────────────────────────────────────
    QWidget   *m_statusTab   = nullptr;
    QMap<QString, OutputStatusRow> m_statusRows;

    // ── Bottom bar ──────────────────────────────────────────────────────────
    QPushButton *m_startBtn    = nullptr;
    QPushButton *m_stopBtn     = nullptr;
    QPushButton *m_restartBtn  = nullptr;
    QCheckBox   *m_autoCtrl    = nullptr;
    QLabel      *m_globalStatus = nullptr;

    // ── Cloud power management ───────────────────────────────────────────────
    QCheckBox   *m_cloudAutoCtrl  = nullptr;
    QComboBox   *m_cloudProvider  = nullptr;
    QLineEdit   *m_cloudApiKey    = nullptr;
    QLineEdit   *m_cloudServerId  = nullptr;
    QLabel      *m_cloudStatus    = nullptr;
    QPushButton *m_cloudStartBtn  = nullptr;
    QPushButton *m_cloudStopBtn   = nullptr;

    CloudProvider *m_cloud;
    RelayApi      *m_api;
    QTimer        *m_pollTimer;
};
