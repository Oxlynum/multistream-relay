#include "relay-dock.hpp"

#include <obs.h>
#include <obs-module.h>
#include <obs-frontend-api.h>

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QFrame>
#include <QPushButton>
#include <QScrollArea>
#include <QSettings>
#include <QJsonArray>
#include <QJsonObject>
#include <QDateTime>
#include <QMessageBox>
#include <QToolTip>
#include <QGraphicsOpacityEffect>
#include <QPropertyAnimation>
#include <QCursor>
#include <QUrl>
#include <QTimer>
#include <QMainWindow>
#include <cmath>
#include <algorithm>
#include <cstring>

// ── palette ─────────────────────────────────────────────────────────────────
static const QString C_LIVE = QStringLiteral("#37d67a");
static const QString C_WARN = QStringLiteral("#ffb020");
static const QString C_ERR  = QStringLiteral("#ff5470");
static const QString C_IDLE = QStringLiteral("#555e6e");
static const QString C_MUTE = QStringLiteral("#8a93a3");
static const QString C_FAINT = QStringLiteral("#6b7280");

// Landscape tee group, portrait tee group, YouTube passthrough — every platform
// SlimCast fans out to. (Facebook was dropped: its low cap dragged the shared
// landscape encode down.)
static const QStringList PLATFORM_NAMES = {"twitch", "kick", "youtube", "tiktok"};
static const QMap<QString, QString> PLATFORM_LABELS = {
    {"twitch",  "Twitch"}, {"kick", "Kick"}, {"youtube", "YouTube"}, {"tiktok", "TikTok"},
};

// ── helpers ─────────────────────────────────────────────────────────────────

// Stylesheet for the Go Live / Stop button, coloured by the given accent.
static QString goLiveStyle(const QString &bg)
{
    return QString(
        "QPushButton{background:%1; color:#0b0e14; font-weight:700; font-size:13px;"
        " border:none; border-radius:8px; padding:8px;}"
        "QPushButton:disabled{background:#2a313d; color:#6b7280;}").arg(bg);
}

static QString formatCredits(int seconds)
{
    if (seconds <= 0) return QStringLiteral("0m");
    int h = seconds / 3600;
    int m = (seconds % 3600) / 60;
    if (h > 0) return QString("%1h %2m").arg(h).arg(m);
    return QString("%1m").arg(m);
}

// A channel is a free HEVC passthrough only when it's YouTube in landscape.
static bool isPassthrough(const PlatformConfig &p)
{
    return p.platform == "youtube" && p.orientation == "landscape";
}

// ── ctor ──────────────────────────────────────────────────────────────────────

RelayDock::RelayDock(QWidget *parent)
    : QDockWidget(parent)
    , m_api(new RelayApi(this))
    , m_pollTimer(new QTimer(this))
{
    setObjectName("SlimCastDock");
    setWindowTitle("SlimCast");

    buildUi();
    loadSettings();

    connect(m_api, &RelayApi::gpuStatusUpdated,  this, &RelayDock::onGpuStatusUpdated);
    connect(m_api, &RelayApi::gpuProvisioned,    this, &RelayDock::onGpuProvisioned);
    connect(m_api, &RelayApi::gpuProvisionFailed, this, &RelayDock::onGpuProvisionFailed);
    connect(m_api, &RelayApi::gpuDestroyed,      this, &RelayDock::onGpuDestroyed);
    connect(m_api, &RelayApi::platformsUpdated,  this, &RelayDock::onPlatformsUpdated);
    connect(m_api, &RelayApi::encodeUpdated,     this, &RelayDock::onEncodeUpdated);
    connect(m_api, &RelayApi::networkError,      this, &RelayDock::onNetworkError);
    connect(m_api, &RelayApi::deviceLinked,      this, &RelayDock::onDeviceLinked);
    connect(m_api, &RelayApi::deviceLinkFailed,  this, &RelayDock::onDeviceLinkFailed);

    m_pollTimer->setInterval(5000);
    connect(m_pollTimer, &QTimer::timeout, this, &RelayDock::onPollTick);

    // Overall Go Live timeout: provisioning (broker search + boot) + connect.
    // If we don't reach Live within this, we give up and clean up.
    m_launchTimeout = new QTimer(this);
    m_launchTimeout->setSingleShot(true);
    m_launchTimeout->setInterval(360000);   // 6 min from pod creation: Docker pull + agent pair
    connect(m_launchTimeout, &QTimer::timeout, this, [this]() {
        abortLaunch("Couldn't get a server online in time. Please try Go Live again.");
    });

    // Platform-alive watchdog: started when OBS begins streaming (our launch).
    // Relay-reach watchdog: started when OBS begins streaming. Cancelled as soon
    // as the relay reports streaming=true (OBS reached the pod and FFmpeg started).
    // If OBS never reaches the relay in 90s → wrong URL/port, cancel the stream.
    // Platform failures (bad stream key, Twitch rejecting) are shown per-channel
    // as "reconnecting" and do NOT kill the stream.
    m_streamWatchdog = new QTimer(this);
    m_streamWatchdog->setSingleShot(true);
    m_streamWatchdog->setInterval(90000);   // 90s from OBS streaming start → relay confirms
    connect(m_streamWatchdog, &QTimer::timeout, this, [this]() {
        blog(LOG_WARNING, "[slimcast] stream watchdog: OBS didn't reach the relay in 90s, stopping");
        obs_frontend_streaming_stop();
        setStatus("OBS didn't reach the relay — check your stream settings", C_ERR);
    });

    if (m_api->hasApiKey()) {
        enterActive();
    } else {
        showSetup(true);
    }
}

// ── UI ──────────────────────────────────────────────────────────────────────

void RelayDock::buildUi()
{
    m_pages = new QStackedWidget(this);
    m_pages->addWidget(buildSetupPage());   // index 0
    m_pages->addWidget(buildActivePage());  // index 1
    setWidget(m_pages);
}

QWidget *RelayDock::buildSetupPage()
{
    auto *w  = new QWidget;
    auto *ly = new QVBoxLayout(w);
    ly->setContentsMargins(14, 18, 14, 14);
    ly->setSpacing(8);

    auto *title = new QLabel("stream everywhere,\nno setup");
    title->setStyleSheet("font-size:15px; font-weight:600; color:#e7ebf2");
    ly->addWidget(title);

    auto *sub = new QLabel("Connect OBS to your SlimCast account in one click — "
                           "your browser will open to authorize this computer.");
    sub->setWordWrap(true);
    sub->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
    ly->addWidget(sub);

    ly->addSpacing(8);

    // Primary path: browser-based PKCE link. No key to copy or paste.
    auto *connectBtn = new QPushButton("Connect with SlimCast");
    connectBtn->setStyleSheet(
        "QPushButton{background:#4d8ef0; color:#0b0e14; font-weight:700; "
        "border:none; border-radius:6px; padding:9px;}"
        "QPushButton:hover{background:#6aa3f4;}");
    ly->addWidget(connectBtn);
    connect(connectBtn, &QPushButton::clicked, this, &RelayDock::onConnectClicked);

    m_setupHint = new QLabel("");
    m_setupHint->setWordWrap(true);
    m_setupHint->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
    m_setupHint->setVisible(false);
    ly->addWidget(m_setupHint);

    ly->addSpacing(10);

    // Fallback: paste a key manually (collapsible-ish; kept small/quiet).
    auto *fallback = new QLabel("Or paste an API key manually:");
    fallback->setStyleSheet(QString("color:%1; font-size:10px").arg(C_FAINT));
    ly->addWidget(fallback);

    m_apiKeyEdit = new QLineEdit;
    m_apiKeyEdit->setEchoMode(QLineEdit::Password);
    m_apiKeyEdit->setPlaceholderText("SlimCast API key");
    ly->addWidget(m_apiKeyEdit);

    auto *saveBtn = new QPushButton("Use key");
    saveBtn->setStyleSheet("padding:6px;");
    ly->addWidget(saveBtn);
    connect(saveBtn, &QPushButton::clicked, this, &RelayDock::onSaveApiKey);

    ly->addStretch();
    return w;
}

static QFrame *makeSep()
{
    auto *f = new QFrame;
    f->setFrameShape(QFrame::HLine);
    f->setStyleSheet("color:#2a2f3a");
    return f;
}

QWidget *RelayDock::buildActivePage()
{
    // Scrollable: the control panel is taller than a docked panel often is.
    auto *scroll = new QScrollArea;
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);

    auto *w  = new QWidget;
    auto *ly = new QVBoxLayout(w);
    ly->setContentsMargins(14, 14, 14, 12);
    ly->setSpacing(10);

    // ── Status header ───────────────────────────────────────────────────────
    auto *headRow = new QHBoxLayout;
    headRow->setSpacing(6);
    m_statusDot = new QLabel("●");
    m_statusDot->setStyleSheet(QString("color:%1; font-size:13px").arg(C_IDLE));
    m_statusLabel = new QLabel("Idle");
    m_statusLabel->setStyleSheet("font-size:14px; font-weight:600; color:#e7ebf2");
    headRow->addWidget(m_statusDot);
    headRow->addWidget(m_statusLabel);
    // Compact warning: a red "⚠" that reveals the OBS-config issue on hover or
    // click (a flat button shows tooltips reliably, unlike a bare QLabel).
    m_serviceWarn = new QPushButton("⚠");
    m_serviceWarn->setFlat(true);
    m_serviceWarn->setCursor(Qt::PointingHandCursor);
    m_serviceWarn->setStyleSheet(
        "QPushButton{color:#ff6b6b; font-size:15px; font-weight:700; border:none; "
        "padding:0 4px; background:transparent;}");
    m_serviceWarn->setVisible(false);
    connect(m_serviceWarn, &QPushButton::clicked, this, [this]() {
        const QString issue = obsServiceIssue();
        if (!issue.isEmpty())
            QToolTip::showText(QCursor::pos(), issue, m_serviceWarn);
    });
    headRow->addWidget(m_serviceWarn);
    headRow->addStretch();
    m_creditsLabel = new QLabel("—");
    m_creditsLabel->setStyleSheet(QString("color:%1; font-size:13px; font-weight:600").arg(C_LIVE));
    headRow->addWidget(m_creditsLabel);
    ly->addLayout(headRow);

    m_ingestLabel = new QLabel("—");
    m_ingestLabel->setStyleSheet(QString("color:%1; font-size:11px").arg(C_FAINT));
    ly->addWidget(m_ingestLabel);

    // Primary control. Provisions the pod → waits until reachable → fills OBS's
    // URL → starts OBS. We never touch OBS's own Start button (coexists cleanly
    // with StreamElements and any other control-panel plugin).
    m_goLiveBtn = new QPushButton("Go Live");
    m_goLiveBtn->setMinimumHeight(34);
    ly->addWidget(m_goLiveBtn);
    connect(m_goLiveBtn, &QPushButton::clicked, this, &RelayDock::onMainBtnClicked);

    // ── "Still streaming?" confirmation banner (hidden until the 12h window) ──
    m_confirmBanner = new QWidget;
    m_confirmBanner->setStyleSheet(
        "background:#3a2a12; border:1px solid #b9821f; border-radius:8px;");
    {
        auto *cb = new QVBoxLayout(m_confirmBanner);
        cb->setContentsMargins(12, 10, 12, 10);
        cb->setSpacing(8);
        m_confirmLabel = new QLabel("Still streaming?");
        m_confirmLabel->setWordWrap(true);
        m_confirmLabel->setStyleSheet("color:#f3d39a; font-size:12px; font-weight:600; background:transparent; border:none;");
        cb->addWidget(m_confirmLabel);
        m_confirmBtn = new QPushButton("Yes, keep streaming");
        m_confirmBtn->setStyleSheet(
            "QPushButton{background:#b9821f; color:#1a1206; font-weight:700; "
            "border:none; border-radius:6px; padding:7px;}"
            "QPushButton:hover{background:#d49a2c;}");
        cb->addWidget(m_confirmBtn);
        connect(m_confirmBtn, &QPushButton::clicked, this, &RelayDock::onConfirmClicked);
    }
    m_confirmBanner->setVisible(false);
    ly->addWidget(m_confirmBanner);

    ly->addWidget(makeSep());

    // ── Channels ──────────────────────────────────────────────────────────────
    for (const QString &id : PLATFORM_NAMES) {
        auto *container = new QWidget;
        auto *cly = new QVBoxLayout(container);
        cly->setContentsMargins(0, 0, 0, 0);
        cly->setSpacing(0);

        auto *top = new QHBoxLayout;
        top->setSpacing(8);
        auto *dot = new QLabel("●");
        dot->setFixedWidth(12);
        dot->setStyleSheet(QString("color:%1").arg(C_IDLE));
        auto *name = new QLabel(PLATFORM_LABELS.value(id, id));
        name->setStyleSheet("color:#cbd2dd; font-size:12px");
        auto *toggle = new QCheckBox;
        top->addWidget(dot);
        top->addWidget(name);
        top->addStretch();
        top->addWidget(toggle);
        cly->addLayout(top);

        auto *sub = new QLabel("off");
        sub->setContentsMargins(20, 0, 0, 0);
        sub->setStyleSheet(QString("color:%1; font-size:10px").arg(C_FAINT));
        cly->addWidget(sub);

        ly->addWidget(container);
        m_channels[id] = {container, dot, name, sub, toggle};
        container->setVisible(false);  // shown once we know the user has this channel

        connect(toggle, &QCheckBox::toggled, this, [this, id](bool on) {
            onChannelToggled(id, on);
        });
    }

    // ── Lock ────────────────────────────────────────────────────────────────
    m_lockCheck = new QCheckBox("Lock channel toggles");
    m_lockCheck->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
    m_lockCheck->setToolTip("Prevents accidental on/off changes. Engages automatically when a stream starts.");
    connect(m_lockCheck, &QCheckBox::toggled, this, &RelayDock::onLockToggled);
    ly->addWidget(m_lockCheck);

    ly->addWidget(makeSep());

    // ── Bitrate caps (per encode group) ───────────────────────────────────────
    auto *capTitle = new QLabel("Bitrate cap");
    capTitle->setStyleSheet("color:#cbd2dd; font-size:12px; font-weight:600");
    ly->addWidget(capTitle);
    auto *capNote = new QLabel("Per encode group — shared by every channel in it.");
    capNote->setStyleSheet(QString("color:%1; font-size:10px").arg(C_FAINT));
    ly->addWidget(capNote);

    auto addCap = [&](const QString &label, QSlider *&slider, QLabel *&val) {
        auto *row = new QHBoxLayout;
        row->setSpacing(8);
        auto *l = new QLabel(label);
        l->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
        l->setFixedWidth(64);
        slider = new QSlider(Qt::Horizontal);
        val = new QLabel("—");
        val->setStyleSheet("color:#cbd2dd; font-size:11px; font-family:monospace");
        val->setFixedWidth(64);
        val->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
        row->addWidget(l);
        row->addWidget(slider, 1);
        row->addWidget(val);
        ly->addLayout(row);
    };
    addCap("Landscape", m_landscapeSlider, m_landscapeVal);
    addCap("Portrait",  m_portraitSlider,  m_portraitVal);

    m_landscapeSlider->setRange(m_encode.landscapeMin, m_encode.landscapeMax);
    m_portraitSlider->setRange(m_encode.portraitMin, m_encode.portraitMax);
    m_landscapeSlider->setSingleStep(250);
    m_portraitSlider->setSingleStep(250);

    connect(m_landscapeSlider, &QSlider::valueChanged, this, [this](int v) {
        m_landscapeVal->setText(QString("%1k").arg(v));
    });
    connect(m_portraitSlider, &QSlider::valueChanged, this, [this](int v) {
        m_portraitVal->setText(QString("%1k").arg(v));
    });
    connect(m_landscapeSlider, &QSlider::sliderReleased, this, &RelayDock::onBitrateReleased);
    connect(m_portraitSlider,  &QSlider::sliderReleased, this, &RelayDock::onBitrateReleased);

    ly->addWidget(makeSep());

    // ── Totals + footer ───────────────────────────────────────────────────────
    m_totalLabel = new QLabel("—");
    m_totalLabel->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
    ly->addWidget(m_totalLabel);

    m_helperLabel = new QLabel("$2 / token · base 1 tkn/hr + 0.2 per extra channel.");
    m_helperLabel->setWordWrap(true);
    m_helperLabel->setStyleSheet(QString("color:%1; font-size:10px").arg(C_FAINT));
    ly->addWidget(m_helperLabel);

    auto *manage = new QLabel(
        "<a href='https://slimcast-oxlynum.vercel.app/dashboard' style='color:#4d8ef0'>Manage account ↗</a>");
    manage->setOpenExternalLinks(true);
    manage->setStyleSheet("font-size:11px");
    ly->addWidget(manage);

    // Unlink this device → back to the setup page (the "Connect" button).
    auto *disconnect = new QPushButton("Disconnect this device");
    disconnect->setFlat(true);
    disconnect->setCursor(Qt::PointingHandCursor);
    disconnect->setStyleSheet(QString(
        "QPushButton{color:%1; font-size:10px; border:none; text-align:left; padding:2px 0;}"
        "QPushButton:hover{color:#e7ebf2;}").arg(C_FAINT));
    ly->addWidget(disconnect);
    connect(disconnect, &QPushButton::clicked, this, &RelayDock::onDisconnect);

    ly->addStretch();

    scroll->setWidget(w);
    return scroll;
}

void RelayDock::showSetup(bool setup)
{
    m_pages->setCurrentIndex(setup ? 0 : 1);
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
}

void RelayDock::saveSettings()
{
    QSettings s("SlimCast", "obs-plugin");
    s.setValue("apiKey", m_apiKeyEdit->text().trimmed());
}

void RelayDock::onSaveApiKey()
{
    QString key = m_apiKeyEdit->text().trimmed();
    if (key.isEmpty()) return;

    m_api->setApiKey(key);
    saveSettings();
    enterActive();
}

void RelayDock::enterActive()
{
    showSetup(false);
    setStatus("Connecting…", C_WARN);
    m_pollTimer->start();
    m_api->fetchGpuStatus();
    m_api->fetchPlatforms();
    m_api->fetchEncode();
}

void RelayDock::onConnectClicked()
{
    if (m_setupHint) {
        m_setupHint->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
        m_setupHint->setText("Opening your browser to authorize…");
        m_setupHint->setVisible(true);
    }
    m_api->beginDeviceLink();
}

void RelayDock::onDeviceLinked(QString apiKey)
{
    // The key arrives via the PKCE exchange — persist it and go active.
    m_apiKeyEdit->setText(apiKey);
    saveSettings();
    enterActive();
}

void RelayDock::onDisconnect()
{
    // If a stream/pod is live, tear it down cleanly BEFORE we throw away the key
    // — otherwise the pod keeps billing and the dock can no longer control it.
    const bool live = obs_frontend_streaming_active() || m_lastGpuInfo.status == "running";
    if (live) {
        const auto btn = QMessageBox::question(
            this, "Disconnect SlimCast",
            "You're live. Disconnecting will stop your stream and shut down the "
            "streaming server. Continue?",
            QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
        if (btn != QMessageBox::Yes) return;

        // destroyGpu()'s request is built with the current key synchronously, so
        // it's authorized even though we clear the key just below. Then stop OBS
        // pushing RTMP to the (now tearing-down) pod.
        m_api->destroyGpu();
        if (obs_frontend_streaming_active())
            obs_frontend_streaming_stop();
    }

    m_pollTimer->stop();
    m_api->setApiKey("");
    m_apiKeyEdit->clear();

    QSettings s("SlimCast", "obs-plugin");
    s.remove("apiKey");

    if (m_setupHint) m_setupHint->setVisible(false);
    showSetup(true);
}

void RelayDock::onDeviceLinkFailed(QString message)
{
    if (m_setupHint) {
        m_setupHint->setStyleSheet(QString("color:%1; font-size:11px").arg(C_ERR));
        m_setupHint->setText(message);
        m_setupHint->setVisible(true);
    }
}

// ── OBS stream lifecycle (the only GPU triggers) ───────────────────────────────

void RelayDock::onObsStreamingStarting()
{
    // Our Go Live flow calls obs_frontend_streaming_start() once the pod is ready
    // — that fires this; just clear the guard and let it proceed. We deliberately
    // do NOT touch OBS's own Start button, so it coexists with StreamElements and
    // any other control-panel plugin. (Use the SlimCast Go Live button to stream.)
    if (m_resumingStream) {
        m_resumingStream = false;
        // Start the platform-alive watchdog: if no output reaches "running"
        // within 90s the RTMP path or stream key is wrong — stop cleanly.
        if (m_streamWatchdog) m_streamWatchdog->start();
    }
}

void RelayDock::onObsStreamingStopped()
{
    if (m_autoLaunching) return;
    m_api->destroyGpu();
    setStatus("Stopping…", C_MUTE);
}

// ── Readiness probe ────────────────────────────────────────────────────────────
// "status: running" + an IP means the pod booted, but NOT that the RTMP ingest
// (MediaMTX + RunPod's TCP proxy) is accepting yet. Resuming OBS too early fails
// the connect. So we TCP-probe the ingest port and only resume once it's open.
// Readiness is signalled by the agent pairing, not a TCP probe. The status
// endpoint returns 'provisioning' while last_seen_at is stale, then flips to
// 'running' the moment the agent first phones home — which means MediaMTX is up
// and the RTMP ingest is accepting. We just watch the existing 5s poll.

// ── Status rendering ──────────────────────────────────────────────────────────

void RelayDock::onGpuStatusUpdated(GpuInfo info)
{
    m_lastGpuInfo = info;

    // If OBS opens and finds a pod already in 'provisioning' state (e.g. from a
    // previous Go Live that was interrupted or whose dock timed out), auto-resume
    // waiting so Cancel works and the 6-min timer runs. If the agent pairs in
    // time, OBS goes live automatically. If not, the timer fires and cleans up.
    if (!m_autoLaunching && !m_shuttingDown && info.status == "provisioning") {
        m_autoLaunching = true;
        m_launchStartMs = QDateTime::currentMSecsSinceEpoch();
        if (m_launchTimeout) m_launchTimeout->start();
    }

    render(info);

    // Agent paired → status flips 'provisioning' → 'running'. That means
    // MediaMTX is up and RTMP is accepting. Set OBS's URL and start streaming.
    if (m_autoLaunching && info.status == "running") {
        if (!info.rtmpUrl.isEmpty()) {
            // Port mapping is in the DB — we have everything we need.
            if (m_launchTimeout) m_launchTimeout->stop();
            m_autoLaunching  = false;
            m_resumingStream = true;
            setStatus("Connecting…", C_WARN);
            applyObsStreamUrl(info.rtmpUrl, info.ingestKey);
            obs_frontend_streaming_start();
        }
        // rtmpUrl is null: pod paired but provision hasn't saved the public port
        // yet (waitForIp() is still polling RunPod's GraphQL — typically resolves
        // within one 5s poll). Stay in autoLaunching; the 6-min timeout backstops.
        return;
    }

    // Relay-reach watchdog: cancel the moment the relay reports streaming=true.
    // That means OBS reached the pod and FFmpeg is running — the connection is good.
    if (m_streamWatchdog && m_streamWatchdog->isActive() && info.streaming)
        m_streamWatchdog->stop();

    // SAFETY: a running pod while OBS is not streaming (and we aren't mid-launch)
    // is an orphan — e.g. OBS crashed and was reopened, or a Stop teardown failed.
    // Confirm across two polls (~10s) to avoid racing the launch/resume window,
    // then destroy it so a forgotten pod can never keep billing.
    const bool obsActive = obs_frontend_streaming_active();
    if (info.status == "running" && !obsActive && !m_autoLaunching && !m_resumingStream) {
        if (++m_orphanTicks >= 2) {
            m_orphanTicks = 0;
            m_api->destroyGpu();
        }
    } else {
        m_orphanTicks = 0;
    }
}

void RelayDock::render(const GpuInfo &info)
{
    // Clear the shutting-down flag once the pod is actually gone.
    if (m_shuttingDown && info.status != "running" && !obs_frontend_streaming_active())
        m_shuttingDown = false;

    // ── Lifecycle status (green = live/ready, yellow = working, red = problem) ──
    const int elapsed = m_launchStartMs
        ? int((QDateTime::currentMSecsSinceEpoch() - m_launchStartMs) / 1000) : 0;
    QString text, color;
    if (m_shuttingDown) {
        text = "Shutting down…";                         color = C_ERR;
    } else if (m_autoLaunching && info.status != "running") {
        if (info.ip.isEmpty())
            text = QString("Searching for a GPU… %1s").arg(elapsed);
        else
            text = QString("Booting server… %1s").arg(elapsed);
        color = C_WARN;
    } else if (info.status == "provisioning") {
        text = "Spinning up server…";                    color = C_WARN;
    } else if (info.status == "running") {
        if (info.streaming) {
            bool anyErr = false, anyRestart = false;
            for (const QString &st : info.platformStates) {
                if (st == "error")      anyErr     = true;
                else if (st == "restarting") anyRestart = true;
            }
            if (anyErr)      { text = "Live · platform error";  color = C_ERR;  }
            else if (anyRestart) { text = "Live · reconnecting…"; color = C_WARN; }
            else             { text = "Live";                   color = C_LIVE; }
        } else {
            text = "Server ready · waiting for OBS";     color = C_WARN;
        }
        m_launchStartMs = 0;                             // startup finished
    } else {
        text = "Idle — not streaming";                   color = C_IDLE;
        m_launchStartMs = 0;
    }
    setStatus(text, color);

    // ── Main action button: Go Live → Cancel (connecting) → Stop Stream (live) ─
    if (m_goLiveBtn) {
        const bool live = info.status == "running" || info.streaming;
        if (m_shuttingDown) {
            m_goLiveBtn->setEnabled(false);
            m_goLiveBtn->setText("Stopping…");
            m_goLiveBtn->setStyleSheet(goLiveStyle(C_WARN));
        } else if (m_autoLaunching) {
            m_goLiveBtn->setEnabled(true);
            m_goLiveBtn->setText("Cancel");
            m_goLiveBtn->setStyleSheet(goLiveStyle(C_ERR));
        } else if (live) {
            m_goLiveBtn->setEnabled(true);
            m_goLiveBtn->setText("Stop Stream");
            m_goLiveBtn->setStyleSheet(goLiveStyle(C_ERR));
        } else {
            m_goLiveBtn->setEnabled(true);
            m_goLiveBtn->setText("Go Live");
            m_goLiveBtn->setStyleSheet(goLiveStyle(C_LIVE));
        }
    }

    m_creditsLabel->setText(formatCredits(info.creditsSeconds));
    const QString cColor = info.creditsSeconds <= 0 ? C_ERR
                         : info.creditsSeconds < 1800 ? C_WARN : C_LIVE;
    m_creditsLabel->setStyleSheet(QString("color:%1; font-size:13px; font-weight:600").arg(cColor));

    // Auto-engage the channel lock the moment a stream begins.
    if (info.streaming && !m_wasStreaming && m_lockCheck && !m_lockCheck->isChecked())
        m_lockCheck->setChecked(true);
    m_wasStreaming = info.streaming;

    updateIngestLabel();
    renderConfirm(info);
    renderServiceBanner();
    renderChannels();
    updateTotals();
}

void RelayDock::renderConfirm(const GpuInfo &info)
{
    if (!m_confirmBanner) return;

    if (!info.confirmRequired) {
        m_confirmBanner->setVisible(false);
        return;
    }

    // Minutes left until the pod auto-ends if the user doesn't confirm.
    qint64 msLeft = info.confirmDeadlineMs - QDateTime::currentMSecsSinceEpoch();
    int minLeft = (int)std::max((qint64)0, msLeft / 60000);
    m_confirmLabel->setText(
        QString("You've been streaming 12 hours. The stream will end "
                "automatically in %1 min unless you confirm.").arg(minLeft));
    m_confirmBanner->setVisible(true);
}

void RelayDock::onConfirmClicked()
{
    if (m_api) m_api->confirmSession();
    if (m_confirmBanner) m_confirmBanner->setVisible(false);
}

void RelayDock::updateIngestLabel()
{
    obs_video_info ovi;
    QString base;
    if (obs_get_video_info(&ovi) && ovi.fps_den > 0) {
        int fps = (int)std::lround((double)ovi.fps_num / (double)ovi.fps_den);
        base = QString("%1×%2 · %3 fps")
            .arg(ovi.output_width).arg(ovi.output_height).arg(fps);
    } else {
        base = QStringLiteral("Resolution set in OBS");
    }

    // H264 B-frames cause DTS to go non-monotonic in MediaMTX's SRT republish,
    // crashing FFmpeg every few seconds. HEVC (H265) doesn't have this problem.
    bool isHevc = true;  // assume OK if we can't read the profile config
    config_t *cfg = obs_frontend_get_profile_config();
    if (cfg) {
        const char *mode  = config_get_string(cfg, "Output", "Mode");
        const char *encId = (mode && strcmp(mode, "Advanced") == 0)
            ? config_get_string(cfg, "AdvOut",        "Encoder")
            : config_get_string(cfg, "SimpleOutput",  "StreamEncoder");
        if (encId && *encId) {
            QString id = QString::fromUtf8(encId).toLower();
            isHevc = id.contains("hevc") || id.contains("h265");
        }
    }

    if (!isHevc) {
        m_ingestLabel->setText(base + " · ⚠ Switch encoder to H265");
        m_ingestLabel->setStyleSheet(
            QString("color:%1; font-size:11px").arg(C_WARN));
        m_ingestLabel->setToolTip(
            "SlimCast requires H265 (HEVC) — H264 breaks the relay.\n"
            "OBS Settings → Output → Streaming → Encoder → Apple VT H265");
    } else {
        m_ingestLabel->setText(base);
        m_ingestLabel->setStyleSheet(
            QString("color:%1; font-size:11px").arg(C_FAINT));
        m_ingestLabel->setToolTip({});
    }
}

void RelayDock::renderChannels()
{
    const bool locked = m_lockCheck && m_lockCheck->isChecked();

    for (const QString &id : PLATFORM_NAMES) {
        ChannelRow &row = m_channels[id];
        const bool present = m_platforms.contains(id);
        row.container->setVisible(present);
        if (!present) continue;

        const PlatformConfig &p = m_platforms[id];

        // Toggle reflects enabled (without re-emitting our own signal).
        row.toggle->blockSignals(true);
        row.toggle->setChecked(p.enabled);
        row.toggle->setEnabled(!locked);
        row.toggle->blockSignals(false);

        // Live dot from the actual runner state.
        const QString st = m_lastGpuInfo.platformStates.value(id);
        QString dotColor, liveText;
        if (st == "running")         { dotColor = C_LIVE; liveText = "live"; }
        else if (st == "restarting") { dotColor = C_WARN; liveText = "reconnecting"; }
        else if (st == "error")      { dotColor = C_ERR;  liveText = "error"; }
        else if (!st.isEmpty())      { dotColor = C_IDLE; liveText = "connecting…"; }
        else                         { dotColor = C_IDLE; liveText = "idle"; }
        row.dot->setStyleSheet(QString("color:%1").arg(dotColor));

        // Cost sub-line.
        if (!p.enabled) {
            row.sub->setText("off");
        } else if (isPassthrough(p)) {
            row.sub->setText(liveText + " · free (passthrough)");
        } else {
            row.sub->setText(liveText + " · +0.2 tkn/hr");
        }
    }
}

void RelayDock::updateTotals()
{
    int transcodedEnabled = 0;
    bool anyEnabled = false;
    for (const QString &id : PLATFORM_NAMES) {
        if (!m_platforms.contains(id)) continue;
        const PlatformConfig &p = m_platforms[id];
        if (!p.enabled) continue;
        anyEnabled = true;
        if (!isPassthrough(p)) transcodedEnabled++;
    }

    double projected = anyEnabled ? 1.0 + 0.2 * std::max(0, transcodedEnabled - 1) : 0.0;
    // While live the server reports the real rate; offline we show the projection.
    double rate = (m_lastGpuInfo.streaming && m_lastGpuInfo.burnRate > 0)
        ? m_lastGpuInfo.burnRate : projected;

    if (rate <= 0) {
        m_totalLabel->setText("No channels enabled.");
    } else {
        m_totalLabel->setText(QString("≈ %1 tkn/hr while live · $%2/hr")
            .arg(rate, 0, 'f', 1)
            .arg(rate * 2.0, 0, 'f', 2));
    }
}

void RelayDock::onPlatformsUpdated(QList<PlatformConfig> platforms)
{
    m_platforms.clear();
    for (const PlatformConfig &p : platforms)
        m_platforms[p.platform] = p;
    renderChannels();
    updateTotals();
}

void RelayDock::onEncodeUpdated(EncodeConfig encode)
{
    m_encode = encode;
    m_haveEncode = true;

    m_landscapeSlider->setRange(encode.landscapeMin, encode.landscapeMax);
    m_portraitSlider->setRange(encode.portraitMin, encode.portraitMax);

    // Don't fight the user mid-drag.
    if (!m_landscapeSlider->isSliderDown()) {
        m_landscapeSlider->setValue(encode.landscape);
        m_landscapeVal->setText(QString("%1k").arg(encode.landscape));
    }
    if (!m_portraitSlider->isSliderDown()) {
        m_portraitSlider->setValue(encode.portrait);
        m_portraitVal->setText(QString("%1k").arg(encode.portrait));
    }
}

void RelayDock::onChannelToggled(const QString &platform, bool enabled)
{
    if (!m_platforms.contains(platform)) return;
    m_platforms[platform].enabled = enabled;  // optimistic
    renderChannels();
    updateTotals();
    m_api->setPlatformEnabled(platform, enabled);
}

void RelayDock::onLockToggled(bool /*locked*/)
{
    renderChannels();  // enables/disables the toggles
}

void RelayDock::onBitrateReleased()
{
    if (!m_haveEncode) return;
    m_api->setEncode(m_landscapeSlider->value(), m_portraitSlider->value());
}

void RelayDock::onGpuProvisioned()
{
    // Pod exists — start the "waiting for agent to pair" timeout from NOW,
    // not from when Go Live was pressed (the provision itself already consumed
    // up to 3 min). Reset the elapsed counter so the UI shows time since boot.
    m_launchStartMs = QDateTime::currentMSecsSinceEpoch();
    if (m_launchTimeout) m_launchTimeout->start();
    m_totalLabel->setText("Server starting…");
}

void RelayDock::onGpuDestroyed()
{
    GpuInfo blank;
    m_lastGpuInfo = blank;
    render(blank);
}

void RelayDock::onGpuProvisionFailed(QString reason)
{
    abortLaunch(reason.isEmpty() ? "Couldn't start a server. Please try again." : reason);
}

void RelayDock::abortLaunch(const QString &message)
{
    if (m_launchTimeout) m_launchTimeout->stop();
    m_autoLaunching = false;
    m_launchStartMs = 0;
    m_api->destroyGpu();        // clean up any half-provisioned pod (idempotent)
    setStatus("Couldn't start", C_ERR);
    if (m_totalLabel) m_totalLabel->setText("Go Live failed — see the popup.");
    // Clear popup so the user sees exactly why it failed.
    QMessageBox::warning(this, "SlimCast — couldn't go live", message);
}


void RelayDock::onPollTick()
{
    if (!m_api->hasApiKey()) return;
    m_api->fetchGpuStatus();
    m_api->fetchPlatforms();
    if (!m_haveEncode) m_api->fetchEncode();
}

void RelayDock::onNetworkError(QString message)
{
    m_totalLabel->setText("Network error: " + message);
}

// ── helpers ───────────────────────────────────────────────────────────────────

// Core: make OBS's streaming service a Custom RTMP service pointed at the given
// server/key. Forces the service type to rtmp_custom (so a Twitch/YouTube preset
// is replaced). Borrowed service ref — do NOT release it.
void RelayDock::setSlimcastService(const QString &server, const QString &key)
{
    obs_service_t *svc = obs_frontend_get_streaming_service();
    const char *type = svc ? obs_service_get_type(svc) : nullptr;

    obs_data_t *settings = obs_data_create();
    obs_data_set_string(settings, "server", server.toUtf8().constData());
    obs_data_set_string(settings, "key", key.toUtf8().constData());

    if (!type || strcmp(type, "rtmp_custom") != 0) {
        obs_service_t *custom =
            obs_service_create("rtmp_custom", "SlimCast", settings, nullptr);
        obs_frontend_set_streaming_service(custom);
        obs_service_release(custom);   // frontend holds its own ref now
    } else {
        obs_service_update(svc, settings);
    }

    obs_data_release(settings);
    obs_frontend_save_streaming_service();
}

void RelayDock::applyObsStreamUrl(const QString &server, const QString &key)
{
    if (server.isEmpty()) return;
    setSlimcastService(server, key);
    renderServiceBanner();
}

// Returns a warning if, while a pod is live, OBS's output drifted off the
// SlimCast server/key (e.g. user changed it mid-stream). Idle → nothing to warn
// (Go Live configures everything itself).
QString RelayDock::obsServiceIssue()
{
    if (m_lastGpuInfo.status != "running" || m_lastGpuInfo.rtmpUrl.isEmpty())
        return "";
    obs_service_t *svc = obs_frontend_get_streaming_service();  // borrowed
    const char *type = svc ? obs_service_get_type(svc) : nullptr;
    if (!type || strcmp(type, "rtmp_custom") != 0)
        return "OBS's stream output isn't on SlimCast. Stop and press Go Live again.";
    obs_data_t *s = obs_service_get_settings(svc);
    const QString curServer = QString::fromUtf8(obs_data_get_string(s, "server"));
    const QString curKey = QString::fromUtf8(obs_data_get_string(s, "key"));
    obs_data_release(s);
    if (curKey != m_lastGpuInfo.ingestKey || curServer != m_lastGpuInfo.rtmpUrl)
        return "OBS isn't pointed at your current SlimCast server. Stop and press "
               "Go Live again.";
    return "";
}

void RelayDock::renderServiceBanner()
{
    if (!m_serviceWarn) return;
    const QString issue = obsServiceIssue();
    if (issue.isEmpty()) {
        m_serviceWarn->setVisible(false);
        return;
    }
    // Hover popup (rich text → wraps at a sane width).
    m_serviceWarn->setToolTip("<div style='max-width:240px'>" + issue.toHtmlEscaped() + "</div>");
    m_serviceWarn->setVisible(true);
}

// The single start/stop control. Idle → provision a pod; the existing
// status-poll → readiness-probe → resume flow fills the real URL and starts OBS.
// Live → stop OBS (which tears the pod down). This is the ONLY start path, so
// OBS never has to connect before the pod/URL exist.
void RelayDock::onGoLiveClicked()
{
    if (m_autoLaunching || false /* m_probing removed */) return;   // already starting

    const bool live = obs_frontend_streaming_active() || m_lastGpuInfo.status == "running";
    if (live) {
        if (m_launchTimeout) m_launchTimeout->stop();
        m_shuttingDown = true;
        if (obs_frontend_streaming_active()) obs_frontend_streaming_stop();
        else                                  m_api->destroyGpu();
        render(m_lastGpuInfo);
        return;
    }

    m_shuttingDown  = false;
    m_autoLaunching = true;
    m_launchStartMs = QDateTime::currentMSecsSinceEpoch();
    // Don't start the timeout yet — it covers the "waiting for agent to pair"
    // phase only. The provision HTTP call has its own 3-min network timeout.
    // We start m_launchTimeout in onGpuProvisioned once the pod exists.
    m_api->provisionGpu();
    render(m_lastGpuInfo);
}

// Dispatcher for the single main button: Go Live | Cancel | Stop Stream.
void RelayDock::onMainBtnClicked()
{
    if (m_shuttingDown) return;

    if (m_autoLaunching) {
        // Cancel: abort the in-flight provision request and destroy any pod
        // that was already created before we gave up.
        m_autoLaunching = false;
        if (m_launchTimeout) m_launchTimeout->stop();
        m_api->cancelProvision();
        m_api->destroyGpu();   // no-op if pod never got created
        setStatus("Cancelled", C_IDLE);
        render(m_lastGpuInfo);
        return;
    }

    onGoLiveClicked();
}

void RelayDock::setStatus(const QString &text, const QString &color)
{
    m_statusDot->setStyleSheet(QString("color:%1; font-size:13px").arg(color));
    m_statusLabel->setText(text);
}
