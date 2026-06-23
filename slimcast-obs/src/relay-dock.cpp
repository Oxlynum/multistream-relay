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
#include <QTcpSocket>
#include <QUrl>
#include <QTimer>
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

    connect(m_api, &RelayApi::gpuStatusUpdated, this, &RelayDock::onGpuStatusUpdated);
    connect(m_api, &RelayApi::gpuProvisioned,   this, &RelayDock::onGpuProvisioned);
    connect(m_api, &RelayApi::gpuDestroyed,     this, &RelayDock::onGpuDestroyed);
    connect(m_api, &RelayApi::platformsUpdated, this, &RelayDock::onPlatformsUpdated);
    connect(m_api, &RelayApi::encodeUpdated,    this, &RelayDock::onEncodeUpdated);
    connect(m_api, &RelayApi::networkError,     this, &RelayDock::onNetworkError);
    connect(m_api, &RelayApi::deviceLinked,     this, &RelayDock::onDeviceLinked);
    connect(m_api, &RelayApi::deviceLinkFailed, this, &RelayDock::onDeviceLinkFailed);

    m_pollTimer->setInterval(5000);
    connect(m_pollTimer, &QTimer::timeout, this, &RelayDock::onPollTick);

    if (m_api->hasApiKey()) {
        showSetup(false);
        m_pollTimer->start();
        m_api->fetchGpuStatus();
        m_api->fetchPlatforms();
        m_api->fetchEncode();
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

    // Manual trigger: point OBS's stream output at SlimCast on demand (it also
    // happens automatically on Start Streaming).
    m_pointObsBtn = new QPushButton("Point OBS at SlimCast");
    m_pointObsBtn->setStyleSheet(
        "QPushButton{background:#1f2a44; color:#cfe0ff; border:1px solid #34507f; "
        "border-radius:6px; padding:7px; font-size:12px;}"
        "QPushButton:hover{background:#26344f;}"
        "QPushButton:disabled{color:#5b6577; border-color:#2a2f3a;}");
    ly->addWidget(m_pointObsBtn);
    connect(m_pointObsBtn, &QPushButton::clicked, this, &RelayDock::onPointObsClicked);

    // Fading "✓" shown briefly after the button is pressed.
    m_pointObsCheck = new QLabel("✓ Pointed at SlimCast");
    m_pointObsCheck->setAlignment(Qt::AlignCenter);
    m_pointObsCheck->setStyleSheet("color:#5fd28a; font-size:11px; font-weight:600;");
    m_pointObsCheck->setVisible(false);
    ly->addWidget(m_pointObsCheck);

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
    if (!m_api->hasApiKey()) {
        m_totalLabel->setText("Connect your SlimCast API key first.");
        return;
    }
    if (m_resumingStream) {
        m_resumingStream = false;
        return;
    }
    if (m_autoLaunching) return;

    // Pod already running (e.g. starting a second time this session) — it's
    // already accepting, so just point OBS at it and let the start proceed.
    if (m_lastGpuInfo.status == "running" && !m_lastGpuInfo.rtmpUrl.isEmpty()) {
        applyObsStreamUrl(m_lastGpuInfo.rtmpUrl, m_lastGpuInfo.ingestKey);
        return;
    }

    obs_frontend_streaming_stop();
    m_autoLaunching = true;
    setStatus("Starting…", C_WARN);
    m_api->provisionGpu();
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
static constexpr int PROBE_MAX_ATTEMPTS = 25;   // ~50s at 2s spacing
static constexpr int PROBE_INTERVAL_MS  = 2000;

void RelayDock::startReadinessProbe(const QString &server, const QString &key)
{
    m_probing       = true;
    m_probeServer   = server;
    m_probeKey      = key;
    m_probeAttempts = 0;
    setStatus("Connecting…", C_WARN);
    probeOnce();
}

void RelayDock::probeOnce()
{
    const QUrl u(m_probeServer);
    const QString host = u.host();
    const int port = u.port(1935);

    auto *sock = new QTcpSocket(this);
    auto *timeout = new QTimer(sock);
    timeout->setSingleShot(true);

    connect(sock, &QTcpSocket::connected, this, [this, sock]() {
        sock->abort();
        sock->deleteLater();
        onProbeSuccess();
    });
    connect(sock, &QTcpSocket::errorOccurred, this, [this, sock](QAbstractSocket::SocketError) {
        sock->deleteLater();
        onProbeRetry();
    });
    // Guard against connectToHost hanging past our interval.
    connect(timeout, &QTimer::timeout, sock, [sock]() {
        if (sock->state() != QAbstractSocket::ConnectedState) sock->abort();
    });

    sock->connectToHost(host, static_cast<quint16>(port));
    timeout->start(PROBE_INTERVAL_MS);
}

void RelayDock::onProbeSuccess()
{
    m_probing        = false;
    m_autoLaunching  = false;
    m_resumingStream = true;
    applyObsStreamUrl(m_probeServer, m_probeKey);
    obs_frontend_streaming_start();
}

void RelayDock::onProbeRetry()
{
    if (!m_probing) return;
    if (++m_probeAttempts >= PROBE_MAX_ATTEMPTS) {
        m_probing       = false;
        m_autoLaunching = false;
        setStatus("Server unreachable", C_ERR);
        if (m_totalLabel)
            m_totalLabel->setText("Couldn't reach your SlimCast server. Stop and try again.");
        return;
    }
    QTimer::singleShot(PROBE_INTERVAL_MS, this, &RelayDock::probeOnce);
}

// ── Status rendering ──────────────────────────────────────────────────────────

void RelayDock::onGpuStatusUpdated(GpuInfo info)
{
    m_lastGpuInfo = info;
    render(info);

    // Pod booted (status running + address). Don't resume OBS yet — first make
    // sure the RTMP ingest is actually accepting (has IP ≠ ingest ready). The
    // probe keeps m_autoLaunching true so the orphan check below stays paused.
    if (m_autoLaunching && !m_probing && info.status == "running" && !info.rtmpUrl.isEmpty()) {
        startReadinessProbe(info.rtmpUrl, info.ingestKey);
        return;
    }
    if (m_probing) return;   // wait for the probe to finish before anything else

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
    if (info.status == "provisioning")
        setStatus("Starting…", C_WARN);
    else if (info.status == "running")
        setStatus(info.streaming ? "Live" : "Ready", C_LIVE);
    else
        setStatus("Idle", C_IDLE);

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
    if (obs_get_video_info(&ovi) && ovi.fps_den > 0) {
        int fps = (int)std::lround((double)ovi.fps_num / (double)ovi.fps_den);
        m_ingestLabel->setText(QString("%1×%2 · %3 fps")
            .arg(ovi.output_width).arg(ovi.output_height).arg(fps));
    } else {
        m_ingestLabel->setText("Resolution set in OBS");
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
        else if (st == "restarting") { dotColor = C_WARN; liveText = "restarting"; }
        else if (st == "error")      { dotColor = C_ERR;  liveText = "error"; }
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
    m_totalLabel->setText("Server starting… (~45 seconds)");
}

void RelayDock::onGpuDestroyed()
{
    GpuInfo blank;
    m_lastGpuInfo = blank;
    render(blank);
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

// No pod yet (no server address exists). At least flip OBS off a Twitch/preset
// onto Custom so it's ready; the real server fills in on Start. If it's already
// Custom we leave it alone (don't wipe a server that may already be set).
void RelayDock::ensureCustomService()
{
    obs_service_t *svc = obs_frontend_get_streaming_service();
    const char *type = svc ? obs_service_get_type(svc) : nullptr;
    if (type && strcmp(type, "rtmp_custom") == 0) return;
    // Flip off a Twitch/preset onto Custom; server + per-pod key fill in on Start.
    setSlimcastService("", "");
}

// Returns a warning if OBS's stream output isn't pointed at SlimCast, else "".
QString RelayDock::obsServiceIssue()
{
    obs_service_t *svc = obs_frontend_get_streaming_service();  // borrowed
    const char *type = svc ? obs_service_get_type(svc) : nullptr;
    if (!type || strcmp(type, "rtmp_custom") != 0) {
        return "OBS isn't pointed at SlimCast. Set Service to “Custom” — or just "
               "press “Point OBS at SlimCast” (it’s also done automatically when "
               "you Start Streaming).";
    }
    // Custom: while a pod is live, verify the server/key actually match it.
    if (m_lastGpuInfo.status == "running" && !m_lastGpuInfo.rtmpUrl.isEmpty()) {
        obs_data_t *s = obs_service_get_settings(svc);
        const QString curServer = QString::fromUtf8(obs_data_get_string(s, "server"));
        const QString curKey = QString::fromUtf8(obs_data_get_string(s, "key"));
        obs_data_release(s);
        if (curKey != m_lastGpuInfo.ingestKey)
            return "Wrong stream key in OBS for SlimCast. Press “Point OBS at "
                   "SlimCast” to fix it.";
        if (curServer != m_lastGpuInfo.rtmpUrl)
            return "OBS isn’t pointed at your current SlimCast server. Press "
                   "“Point OBS at SlimCast” to fix it.";
    }
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

void RelayDock::onPointObsClicked()
{
    const bool podLive = m_lastGpuInfo.status == "running" && !m_lastGpuInfo.rtmpUrl.isEmpty();
    if (podLive) {
        applyObsStreamUrl(m_lastGpuInfo.rtmpUrl, m_lastGpuInfo.ingestKey);
    } else {
        ensureCustomService();                       // flip to Custom; server+key fill on Start
    }
    // The warning "⚠" clears itself if the issue is resolved.
    renderServiceBanner();
    flashPointedFeedback();
}

void RelayDock::flashPointedFeedback()
{
    if (!m_pointObsCheck) return;
    m_pointObsCheck->setVisible(true);

    auto *fx = new QGraphicsOpacityEffect(m_pointObsCheck);
    m_pointObsCheck->setGraphicsEffect(fx);
    auto *anim = new QPropertyAnimation(fx, "opacity", this);
    anim->setDuration(1500);
    anim->setKeyValueAt(0.0, 1.0);
    anim->setKeyValueAt(0.5, 1.0);   // hold briefly, then fade
    anim->setKeyValueAt(1.0, 0.0);
    connect(anim, &QPropertyAnimation::finished, m_pointObsCheck, [this]() {
        m_pointObsCheck->setVisible(false);
        m_pointObsCheck->setGraphicsEffect(nullptr);
    });
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void RelayDock::setStatus(const QString &text, const QString &color)
{
    m_statusDot->setStyleSheet(QString("color:%1; font-size:13px").arg(color));
    m_statusLabel->setText(text);
}
