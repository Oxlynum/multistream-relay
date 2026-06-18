#include "relay-dock.hpp"

#include <obs-module.h>
#include <obs-frontend-api.h>

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QTabWidget>
#include <QFrame>
#include <QGroupBox>
#include <QScrollArea>
#include <QSettings>
#include <QJsonArray>
#include <QJsonObject>

// ── helpers ───────────────────────────────────────────────────────────────────

static QString formatCredits(int seconds)
{
    if (seconds <= 0) return QStringLiteral("0m");
    int h = seconds / 3600;
    int m = (seconds % 3600) / 60;
    if (h > 0)
        return QString("%1h %2m").arg(h).arg(m);
    return QString("%1m").arg(m);
}

static QString dotColor(const QString &state)
{
    if (state == "running")    return QStringLiteral("#37d67a");
    if (state == "restarting") return QStringLiteral("#ffb020");
    if (state == "error")      return QStringLiteral("#ff5470");
    return QStringLiteral("#555e6e");
}

static const QStringList PLATFORM_NAMES = {"twitch", "kick", "youtube", "tiktok", "facebook"};
static const QMap<QString, QString> PLATFORM_LABELS = {
    {"twitch",   "Twitch"},
    {"kick",     "Kick"},
    {"youtube",  "YouTube"},
    {"tiktok",   "TikTok"},
    {"facebook", "Facebook"},
};

// ── ctor ─────────────────────────────────────────────────────────────────────

RelayDock::RelayDock(QWidget *parent)
    : QDockWidget(parent)
    , m_api(new RelayApi(this))
    , m_launchPollTimer(new QTimer(this))
    , m_statusPollTimer(new QTimer(this))
{
    setObjectName("SlimCastDock");
    setWindowTitle("SlimCast");

    buildUi();
    loadSettings();

    connect(m_api, &RelayApi::gpuStatusUpdated, this, &RelayDock::onGpuStatusUpdated);
    connect(m_api, &RelayApi::gpuProvisioned,   this, &RelayDock::onGpuProvisioned);
    connect(m_api, &RelayApi::networkError,     this, &RelayDock::onNetworkError);
    connect(m_api, &RelayApi::creditsUpdated, this, [this](int s) { setCreditsLabel(s); });

    m_launchPollTimer->setInterval(5000);
    connect(m_launchPollTimer, &QTimer::timeout, this, &RelayDock::onLaunchPollTick);

    m_statusPollTimer->setInterval(5000);
    connect(m_statusPollTimer, &QTimer::timeout, this, &RelayDock::onStatusPollTick);

    if (m_api->hasApiKey()) {
        m_statusPollTimer->start();
        m_api->fetchGpuStatus();
    }
}

// ── UI ────────────────────────────────────────────────────────────────────────

void RelayDock::buildUi()
{
    auto *root   = new QWidget(this);
    auto *rootLy = new QVBoxLayout(root);
    rootLy->setContentsMargins(6, 6, 6, 6);
    rootLy->setSpacing(4);

    auto *tabs = new QTabWidget(root);

    // ── Account tab ──────────────────────────────────────────────────────────
    {
        auto *w  = new QWidget;
        auto *fl = new QFormLayout(w);
        fl->setContentsMargins(8, 8, 8, 8);
        fl->setSpacing(8);

        m_apiKeyEdit = new QLineEdit;
        m_apiKeyEdit->setEchoMode(QLineEdit::Password);
        m_apiKeyEdit->setPlaceholderText("Paste your SlimCast API key");
        fl->addRow("API key", m_apiKeyEdit);

        auto *saveBtn = new QPushButton("Save");
        fl->addRow(saveBtn);
        connect(saveBtn, &QPushButton::clicked, this, &RelayDock::onSaveApiKey);

        auto *sep = new QFrame;
        sep->setFrameShape(QFrame::HLine);
        sep->setStyleSheet("color:#3a3f4b");
        fl->addRow(sep);

        m_serverStatus = new QLabel("● Offline");
        m_serverStatus->setStyleSheet("color:gray");
        fl->addRow("Server", m_serverStatus);

        m_creditsLabel = new QLabel("—");
        m_creditsLabel->setStyleSheet("color:gray");
        fl->addRow("Credits", m_creditsLabel);

        auto *keyNote = new QLabel(
            "<a href='https://slimcast.com/dashboard' style='color:#4d8ef0'>Get your API key →</a>"
        );
        keyNote->setOpenExternalLinks(true);
        fl->addRow(keyNote);

        tabs->addTab(w, "Account");
    }

    // ── Status tab ───────────────────────────────────────────────────────────
    {
        auto *w  = new QWidget;
        auto *ly = new QVBoxLayout(w);
        ly->setContentsMargins(8, 8, 8, 8);
        ly->setSpacing(6);

        auto *platBox = new QGroupBox("Platforms");
        auto *platLy  = new QVBoxLayout(platBox);
        platLy->setSpacing(4);

        for (const QString &id : PLATFORM_NAMES) {
            auto *row  = new QWidget;
            auto *rowL = new QHBoxLayout(row);
            rowL->setContentsMargins(0, 0, 0, 0);
            rowL->setSpacing(6);

            auto *dot   = new QLabel("●");
            dot->setFixedWidth(14);
            dot->setStyleSheet("color:#555e6e");
            auto *label = new QLabel(PLATFORM_LABELS.value(id, id));

            rowL->addWidget(dot);
            rowL->addWidget(label);
            rowL->addStretch();

            platLy->addWidget(row);
            m_platformRows[id] = {dot, label};
        }

        ly->addWidget(platBox);

        m_streamingLabel = new QLabel("Not streaming");
        m_streamingLabel->setAlignment(Qt::AlignCenter);
        m_streamingLabel->setStyleSheet("color:gray; font-size: 11px;");
        ly->addWidget(m_streamingLabel);

        ly->addStretch();
        tabs->addTab(w, "Status");
    }

    rootLy->addWidget(tabs, 1);

    // ── Separator ────────────────────────────────────────────────────────────
    auto *sep = new QFrame;
    sep->setFrameShape(QFrame::HLine);
    sep->setStyleSheet("color:#3a3f4b");
    rootLy->addWidget(sep);

    // ── Controls ─────────────────────────────────────────────────────────────
    auto *btnRow = new QHBoxLayout;
    m_startBtn = new QPushButton("▶ Start");
    m_stopBtn  = new QPushButton("⏹ Stop");
    btnRow->addWidget(m_startBtn);
    btnRow->addWidget(m_stopBtn);
    rootLy->addLayout(btnRow);

    m_autoLaunch = new QCheckBox("Auto-start server when I stream");
    m_autoLaunch->setChecked(true);
    rootLy->addWidget(m_autoLaunch);

    m_statusBar = new QLabel("—");
    m_statusBar->setAlignment(Qt::AlignCenter);
    m_statusBar->setStyleSheet("color:gray; font-size: 10px;");
    rootLy->addWidget(m_statusBar);

    setWidget(root);

    connect(m_startBtn, &QPushButton::clicked, this, &RelayDock::onStartRelay);
    connect(m_stopBtn,  &QPushButton::clicked, this, &RelayDock::onStopRelay);
}

// ── Settings ──────────────────────────────────────────────────────────────────

void RelayDock::loadSettings()
{
    QSettings s("SlimCast", "obs-plugin");
    QString key = s.value("apiKey").toString();
    if (!key.isEmpty()) {
        m_apiKeyEdit->setText(key);
        m_api->setApiKey(key);
    }
    m_autoLaunch->setChecked(s.value("autoLaunch", true).toBool());
}

void RelayDock::saveSettings()
{
    QSettings s("SlimCast", "obs-plugin");
    s.setValue("apiKey",     m_apiKeyEdit->text().trimmed());
    s.setValue("autoLaunch", m_autoLaunch->isChecked());
}

// ── Account tab slots ─────────────────────────────────────────────────────────

void RelayDock::onSaveApiKey()
{
    QString key = m_apiKeyEdit->text().trimmed();
    if (key.isEmpty()) return;

    m_api->setApiKey(key);
    saveSettings();
    setServerStatus("Connecting…", "gray");
    m_statusPollTimer->start();
    m_api->fetchGpuStatus();
    m_api->fetchCredits();
}

// ── Manual relay controls ─────────────────────────────────────────────────────

void RelayDock::onStartRelay()
{
    if (!m_api->hasApiKey()) {
        m_statusBar->setText("Enter your API key first.");
        return;
    }
    // If GPU isn't running, provision it first.
    if (m_lastGpuInfo.status != "running") {
        m_statusBar->setText("Starting server…");
        m_autoLaunching = true;
        m_api->provisionGpu();
        m_launchPollTimer->start();
        return;
    }
    m_api->sendControl("start");
    m_statusBar->setText("Start command sent.");
}

void RelayDock::onStopRelay()
{
    if (!m_api->hasApiKey()) return;
    m_api->sendControl("stop");
    m_statusBar->setText("Stop command sent.");
}

// ── OBS stream event handlers ─────────────────────────────────────────────────

void RelayDock::onObsStreamingStarting()
{
    if (!m_api->hasApiKey()) return;
    if (m_resumingStream) {
        // This is our own programmatic restart after GPU came online.
        m_resumingStream = false;
        m_api->sendControl("start");
        return;
    }
    if (m_autoLaunching) return; // already handling a launch

    if (!m_autoLaunch->isChecked()) {
        // Manual mode: just send start to an already-running GPU.
        if (!m_lastGpuInfo.rtmpUrl.isEmpty())
            applyObsStreamUrl(m_lastGpuInfo.rtmpUrl);
        m_api->sendControl("start");
        return;
    }

    // Auto-launch mode: check current GPU status first.
    if (m_lastGpuInfo.status == "running" && !m_lastGpuInfo.rtmpUrl.isEmpty()) {
        // GPU already up — just configure OBS URL and send start.
        applyObsStreamUrl(m_lastGpuInfo.rtmpUrl);
        m_api->sendControl("start");
    } else {
        // GPU not ready. Cancel this stream attempt and boot the GPU.
        obs_frontend_streaming_stop();         // fires STREAMING_STOPPED — handled below
        m_autoLaunching = true;
        setServerStatus("Starting…", "#ffb020");
        m_statusBar->setText("Starting streaming server (~45s)…");
        m_api->provisionGpu();
        m_launchPollTimer->start();
    }
}

void RelayDock::onObsStreamingStopped()
{
    if (m_autoLaunching) {
        // We triggered this stop ourselves to wait for GPU provisioning.
        // Don't relay the stop signal to the server.
        return;
    }
    m_api->sendControl("stop");
}

// ── GPU status & launch polling ───────────────────────────────────────────────

void RelayDock::onGpuStatusUpdated(GpuInfo info)
{
    m_lastGpuInfo = info;

    // Update server status label.
    if (info.status == "running")
        setServerStatus("● Online", "#37d67a");
    else if (info.status == "provisioning")
        setServerStatus("● Starting…", "#ffb020");
    else
        setServerStatus("● Offline", "gray");

    setCreditsLabel(info.creditsSeconds);

    // If we're in auto-launch mode and the GPU just came online, finish the launch.
    if (m_autoLaunching && info.status == "running" && !info.rtmpUrl.isEmpty()) {
        m_launchPollTimer->stop();
        m_autoLaunching  = false;
        m_resumingStream = true;
        applyObsStreamUrl(info.rtmpUrl);
        m_statusBar->setText("Server online — starting stream.");
        obs_frontend_streaming_start();
    }
}

void RelayDock::onGpuProvisioned()
{
    // Provision call succeeded — GPU is now starting up.
    // launchPollTimer is already running; it will call fetchGpuStatus every 5s
    // until status == "running".
    m_statusBar->setText("Server starting… (~45 seconds)");
}

void RelayDock::onLaunchPollTick()
{
    m_api->fetchGpuStatus();
}

void RelayDock::onStatusPollTick()
{
    if (!m_api->hasApiKey()) return;
    m_api->fetchGpuStatus();
}

// ── Error handling ────────────────────────────────────────────────────────────

void RelayDock::onNetworkError(QString message)
{
    m_statusBar->setText("Network error: " + message);
    if (m_autoLaunching) {
        // Don't get stuck — retry on next poll tick.
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

void RelayDock::applyObsStreamUrl(const QString &rtmpUrl)
{
    if (rtmpUrl.isEmpty()) return;

    obs_service_t *svc = obs_frontend_get_streaming_service();
    if (!svc) return;

    obs_data_t *settings = obs_service_get_settings(svc);
    obs_data_set_string(settings, "server", rtmpUrl.toUtf8().constData());
    obs_data_set_string(settings, "key", "live");
    obs_service_update(svc, settings);
    obs_data_release(settings);
    obs_service_release(svc);
    obs_frontend_save_streaming_service();
}

void RelayDock::setServerStatus(const QString &text, const QString &color)
{
    m_serverStatus->setText(text);
    m_serverStatus->setStyleSheet("color:" + color);
}

void RelayDock::setCreditsLabel(int seconds)
{
    QString text = formatCredits(seconds);
    m_creditsLabel->setText(text);
    if (seconds <= 0)
        m_creditsLabel->setStyleSheet("color:#ff5470; font-weight:bold");
    else if (seconds < 1800)
        m_creditsLabel->setStyleSheet("color:#ffb020; font-weight:bold");
    else
        m_creditsLabel->setStyleSheet("color:#37d67a");

    if (seconds < 1800 && seconds > 0) {
        m_statusBar->setText(
            QString("⚠ Less than %1 of streaming time remaining").arg(formatCredits(seconds))
        );
        m_statusBar->setStyleSheet("color:#ffb020; font-size:10px");
    } else if (seconds <= 0) {
        m_statusBar->setText("⚠ No credits — streaming will stop");
        m_statusBar->setStyleSheet("color:#ff5470; font-size:10px");
    }
}
