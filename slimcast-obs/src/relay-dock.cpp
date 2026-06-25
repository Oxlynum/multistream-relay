#include "relay-dock.hpp"

#include <QTabWidget>

#include <obs.h>
#include <obs-module.h>
#include <obs-frontend-api.h>
#include <util/config-file.h>

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
#include <QProcess>
#include <QCoreApplication>
#include <cmath>
#include <algorithm>
#include <cstring>

// ── palette ─────────────────────────────────────────────────────────────────
static const QString C_LIVE  = QStringLiteral("#37d67a");  // green — ONLY when actually streaming
static const QString C_WARN  = QStringLiteral("#ffb020");  // amber — transitioning / low credits
static const QString C_ERR   = QStringLiteral("#ff5470");  // red — error / stop
static const QString C_IDLE  = QStringLiteral("#555e6e");  // dim — idle/stopped
static const QString C_MUTE  = QStringLiteral("#8a93a3");  // light muted — neutral labels
static const QString C_FAINT = QStringLiteral("#6b7280");  // dim muted — fine print
static const QString C_CTA   = QStringLiteral("#e7ebf2");  // near-white — Go Live button (not live yet)

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

static QString formatCredits(double tokens)
{
    if (tokens <= 0) return QStringLiteral("0 tkn");
    if (tokens >= 100) return QString("%1 tkn").arg(static_cast<int>(tokens));
    if (tokens >= 10)  return QString("%1 tkn").arg(tokens, 0, 'f', 1);
    return QString("%1 tkn").arg(tokens, 0, 'f', 3);
}

// A channel is a free HEVC passthrough only when it's YouTube in landscape.
static bool isPassthrough(const PlatformConfig &p)
{
    return p.platform == "youtube" && p.orientation == "landscape";
}

// ── HEVC encoder auto-detection ───────────────────────────────────────────────
// How a given encoder family stores its "disable B-frames" setting in
// streamEncoder.json. Apple VT uses a bool "bframes"; QSV uses an int "bframes";
// NVENC / AMF / VAAPI use an int "bf".
enum BframeFamily { BF_VT_BOOL, BF_QSV_INT, BF_BF_INT };

// Pick the best hardware HEVC encoder OBS has registered on this machine.
// Registration is hardware/driver-gated (NVENC only appears with an NVIDIA GPU,
// VideoToolbox only on macOS, …), so an id being present means it's usable.
// Returns false if no HEVC encoder exists at all.
static bool pickHevcEncoder(QString &idOut, QString &nameOut, int &bfFamily)
{
    QStringList hevc;
    const char *id = nullptr;
    for (size_t i = 0; obs_enum_encoder_types(i, &id); ++i) {
        if (!id) continue;
        const char *codec = obs_get_encoder_codec(id);
        if (codec && strcmp(codec, "hevc") == 0)
            hevc << QString::fromUtf8(id);
    }
    if (hevc.isEmpty()) return false;

    QString chosen;
#ifdef __APPLE__
    // Apple VideoToolbox hardware HEVC ids carry "ave"; software ones don't.
    for (const QString &h : hevc)
        if (h.contains("ave")) { chosen = h; break; }
#else
    // Hardware first: NVENC → QSV → AMF → VAAPI.
    static const QStringList prefer = {
        "obs_nvenc_hevc_tex", "jim_hevc_nvenc", "obs_nvenc_hevc_cuda", "ffmpeg_hevc_nvenc",
        "obs_qsv11_hevc", "h265_texture_amf",
        "hevc_ffmpeg_vaapi_tex", "hevc_ffmpeg_vaapi"};
    for (const QString &p : prefer)
        if (hevc.contains(p)) { chosen = p; break; }
#endif
    if (chosen.isEmpty()) chosen = hevc.first();

    idOut = chosen;
    const char *disp = obs_encoder_get_display_name(chosen.toUtf8().constData());
    nameOut = disp ? QString::fromUtf8(disp) : chosen;

    const QString c = chosen.toLower();
    if (c.contains("qsv"))                                   bfFamily = BF_QSV_INT;
    else if (c.contains("nvenc") || c.contains("amf") ||
             c.contains("vaapi"))                            bfFamily = BF_BF_INT;
    else                                                     bfFamily = BF_VT_BOOL;  // Apple VT
    return true;
}

// Relaunch OBS. There's no public restart API and OBS's internal `restart` flag
// lives in the host executable (not linkable from a plugin), so we spawn a
// detached watcher that waits for this process to exit — releasing OBS's
// single-instance lock — then reopens the app, and ask the main window to close
// so OBS shuts down cleanly (saving scenes/profile on the way out).
static void restartObs()
{
    const qint64 pid = QCoreApplication::applicationPid();
    const QString exe = QCoreApplication::applicationFilePath();

#ifdef __APPLE__
    QString app = exe;                          // …/OBS.app/Contents/MacOS/OBS → …/OBS.app
    const int idx = app.indexOf("/Contents/MacOS/");
    if (idx > 0) app = app.left(idx);
    const QString sh = QString(
        "while kill -0 %1 2>/dev/null; do sleep 0.2; done; sleep 0.4; open \"%2\"")
        .arg(pid).arg(app);
    QProcess::startDetached("/bin/sh", {"-c", sh});
#elif defined(_WIN32)
    QProcess::startDetached("powershell", QStringList{
        "-NoProfile", "-WindowStyle", "Hidden", "-Command",
        QString("Wait-Process -Id %1 -ErrorAction SilentlyContinue; Start-Process '%2'")
            .arg(pid).arg(exe)});
#else
    const QString sh = QString(
        "while kill -0 %1 2>/dev/null; do sleep 0.2; done; sleep 0.4; \"%2\" &")
        .arg(pid).arg(exe);
    QProcess::startDetached("/bin/sh", {"-c", sh});
#endif

    if (auto *win = static_cast<QWidget *>(obs_frontend_get_main_window()))
        QMetaObject::invokeMethod(win, "close", Qt::QueuedConnection);
}

// ── ctor ──────────────────────────────────────────────────────────────────────

RelayDock::RelayDock(QWidget *parent)
    : QWidget(parent)
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

    auto *tabs = new QTabWidget;
    tabs->setStyleSheet(
        "QTabWidget::pane{border:none; background:#0b0e14;}"
        "QTabBar::tab{background:#161b26; color:#8a93a3; padding:7px 16px;"
        " border:none; font-size:12px;}"
        "QTabBar::tab:selected{background:#1a2035; color:#e7ebf2;"
        " border-bottom:2px solid #4d8ef0;}"
        "QTabBar::tab:hover:!selected{background:#1a1f2b;}");

    tabs->addTab(buildStreamTab(), "Stream");
    tabs->addTab(buildOutputsTab(), "Outputs");
    tabs->addTab(buildSlimSyncTab(), "System");

    m_pages->addWidget(tabs);               // index 1

    auto *lay = new QVBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->setSpacing(0);
    lay->addWidget(m_pages);
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

QWidget *RelayDock::buildStreamTab()
{
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
    m_creditsLabel->setStyleSheet(QString("color:%1; font-size:13px; font-weight:600").arg(C_MUTE));
    headRow->addWidget(m_creditsLabel);
    ly->addLayout(headRow);

    m_ingestLabel = new QLabel("—");
    m_ingestLabel->setStyleSheet(QString("color:%1; font-size:11px").arg(C_FAINT));
    ly->addWidget(m_ingestLabel);

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

    m_healthWidget = new HealthGraphWidget;
    ly->addWidget(m_healthWidget);

    ly->addStretch();
    scroll->setWidget(w);
    return scroll;
}

QWidget *RelayDock::buildOutputsTab()
{
    auto *scroll = new QScrollArea;
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);

    auto *w  = new QWidget;
    auto *ly = new QVBoxLayout(w);
    ly->setContentsMargins(14, 14, 14, 12);
    ly->setSpacing(10);

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

    auto addCap = [&](const QString &label, QSpinBox *&spin) {
        auto *row = new QHBoxLayout;
        row->setSpacing(8);
        auto *l = new QLabel(label);
        l->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
        l->setFixedWidth(64);
        spin = new QSpinBox;
        spin->setSuffix(" kbps");
        spin->setSingleStep(250);
        spin->setStyleSheet(
            "QSpinBox { color:#cbd2dd; background:#1a2035; border:1px solid #2a3555;"
            " border-radius:4px; padding:2px 4px; font-size:11px; font-family:monospace; }"
            "QSpinBox::up-button, QSpinBox::down-button { width:16px; }"
        );
        row->addWidget(l);
        row->addWidget(spin, 1);
        ly->addLayout(row);
    };
    addCap("Landscape", m_landscapeSpin);
    addCap("Portrait",  m_portraitSpin);

    m_landscapeSpin->setRange(m_encode.landscapeMin, m_encode.landscapeMax);
    m_portraitSpin->setRange(m_encode.portraitMin, m_encode.portraitMax);
    m_landscapeSpin->setValue(m_encode.landscape);
    m_portraitSpin->setValue(m_encode.portrait);

    connect(m_landscapeSpin, &QSpinBox::editingFinished, this, &RelayDock::onBitrateReleased);
    connect(m_portraitSpin,  &QSpinBox::editingFinished, this, &RelayDock::onBitrateReleased);

    ly->addWidget(makeSep());

    // ── Totals ───────────────────────────────────────────────────────────────
    m_totalLabel = new QLabel("—");
    m_totalLabel->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
    ly->addWidget(m_totalLabel);

    m_helperLabel = new QLabel("$2 / token · base 1 tkn/hr + 0.2 per extra channel.");
    m_helperLabel->setWordWrap(true);
    m_helperLabel->setStyleSheet(QString("color:%1; font-size:10px").arg(C_FAINT));
    ly->addWidget(m_helperLabel);

    ly->addStretch();
    scroll->setWidget(w);
    return scroll;
}

QWidget *RelayDock::buildSlimSyncTab()
{
    auto *scroll = new QScrollArea;
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);

    auto *w  = new QWidget;
    auto *ly = new QVBoxLayout(w);
    ly->setContentsMargins(14, 18, 14, 12);
    ly->setSpacing(12);

    // ── One-click OBS tuning ──────────────────────────────────────────────────
    auto *tuneTitle = new QLabel("OBS encoder setup");
    tuneTitle->setStyleSheet("font-size:13px; font-weight:600; color:#e7ebf2");
    ly->addWidget(tuneTitle);

    auto *tuneNote = new QLabel(
        "Detects your hardware HEVC encoder — Apple VideoToolbox on Mac, "
        "NVIDIA / AMD / Intel on PC — and switches OBS to SlimCast's "
        "recommended settings: custom service, advanced output, CBR, "
        "dynamic bitrate on, B-frames off.");
    tuneNote->setWordWrap(true);
    tuneNote->setStyleSheet(QString("color:%1; font-size:11px").arg(C_MUTE));
    ly->addWidget(tuneNote);

    auto *autoBtn = new QPushButton("Auto-configure OBS for SlimCast");
    autoBtn->setStyleSheet(
        "QPushButton{background:#4d8ef0; color:#0b0e14; font-weight:700; "
        "border:none; border-radius:6px; padding:9px;}"
        "QPushButton:hover{background:#6aa3f4;}");
    ly->addWidget(autoBtn);
    connect(autoBtn, &QPushButton::clicked, this, &RelayDock::onAutoConfigure);

    ly->addWidget(makeSep());

    // ── Account ───────────────────────────────────────────────────────────────
    auto *title = new QLabel("Account");
    title->setStyleSheet("font-size:13px; font-weight:600; color:#e7ebf2");
    ly->addWidget(title);

    auto *connectedRow = new QHBoxLayout;
    connectedRow->setSpacing(6);
    auto *connDot = new QLabel("●");
    connDot->setStyleSheet(QString("color:%1; font-size:11px").arg(C_LIVE));
    auto *connLabel = new QLabel("Connected to SlimCast");
    connLabel->setStyleSheet(QString("color:%1; font-size:12px").arg(C_MUTE));
    connectedRow->addWidget(connDot);
    connectedRow->addWidget(connLabel);
    connectedRow->addStretch();
    ly->addLayout(connectedRow);

    ly->addWidget(makeSep());

    auto *manage = new QLabel(
        "<a href='https://slimcast-oxlynum.vercel.app/dashboard' style='color:#4d8ef0'>Manage account ↗</a>");
    manage->setOpenExternalLinks(true);
    manage->setStyleSheet("font-size:12px");
    ly->addWidget(manage);

    ly->addSpacing(4);

    auto *disconnect = new QPushButton("Disconnect account");
    disconnect->setFlat(true);
    disconnect->setCursor(Qt::PointingHandCursor);
    disconnect->setStyleSheet(QString(
        "QPushButton{color:%1; font-size:11px; border:none; text-align:left; padding:2px 0;}"
        "QPushButton:hover{color:#ff5470;}").arg(C_FAINT));
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
    if (m_healthWidget)
        m_healthWidget->setApiKey(m_apiKeyEdit->text().trimmed());
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
    if (m_healthWidget) m_healthWidget->setApiKey("");

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
        // SRT mode (UDP-capable host) takes precedence: the server returns srt_url
        // and the publish key is embedded in its streamid, so OBS's key field is
        // empty. Otherwise use RTMP. Both share OBS's rtmp_custom service — OBS
        // routes by the URL scheme (srt:// → SRT output).
        if (!info.srtUrl.isEmpty() || !info.rtmpUrl.isEmpty()) {
            // Port mapping is in the DB — we have everything we need.
            if (m_launchTimeout) m_launchTimeout->stop();
            m_autoLaunching  = false;
            m_resumingStream = true;
            setStatus("Connecting…", C_WARN);
            if (!info.srtUrl.isEmpty())
                applyObsStreamUrl(info.srtUrl, QString());
            else
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
            bool anyRunning = false, anyErr = false, anyRestart = false;
            for (const QString &st : info.platformStates) {
                if (st == "running")         anyRunning = true;
                if (st == "error")           anyErr     = true;
                else if (st == "restarting") anyRestart = true;
            }
            if (!anyRunning)   { text = "OBS connected · starting…"; color = C_WARN; }
            else if (anyErr)   { text = "Live · platform error";      color = C_ERR;  }
            else if (anyRestart) { text = "Live · reconnecting…";     color = C_WARN; }
            else               { text = "Live";                        color = C_LIVE; }
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
            m_goLiveBtn->setStyleSheet(goLiveStyle(C_CTA));
        }
    }

    m_creditsLabel->setText(formatCredits(info.creditsTokens));
    // Green only when streaming with a healthy balance; neutral otherwise.
    const QString cColor = info.creditsTokens <= 0  ? C_ERR
                         : info.creditsTokens < 0.5 ? C_WARN
                         : info.streaming            ? C_LIVE
                                                     : C_MUTE;
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
    if (m_healthWidget) m_healthWidget->setStreaming(info.streaming);
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
    QStringList platformIds;
    for (const PlatformConfig &p : platforms) {
        m_platforms[p.platform] = p;
        platformIds.append(p.platform);
    }
    renderChannels();
    updateTotals();
    if (m_healthWidget) m_healthWidget->setActivePlatforms(platformIds);
}

void RelayDock::onEncodeUpdated(EncodeConfig encode)
{
    m_encode = encode;
    m_haveEncode = true;

    m_landscapeSpin->setRange(encode.landscapeMin, encode.landscapeMax);
    m_portraitSpin->setRange(encode.portraitMin, encode.portraitMax);

    // Don't overwrite a value the user is currently editing.
    if (!m_landscapeSpin->hasFocus())
        m_landscapeSpin->setValue(encode.landscape);
    if (!m_portraitSpin->hasFocus())
        m_portraitSpin->setValue(encode.portrait);
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
    m_api->setEncode(m_landscapeSpin->value(), m_portraitSpin->value());
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

void RelayDock::onNetworkError(QString /*message*/)
{
    m_totalLabel->setText("Can't reach SlimCast — check your internet connection.");
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
    // In SRT mode the expected output is the srt:// URL with an empty key (the
    // publish key rides in the streamid); otherwise the rtmp:// URL + ingest key.
    const bool srt = !m_lastGpuInfo.srtUrl.isEmpty();
    const QString expectServer = srt ? m_lastGpuInfo.srtUrl : m_lastGpuInfo.rtmpUrl;
    const QString expectKey    = srt ? QString() : m_lastGpuInfo.ingestKey;
    if (m_lastGpuInfo.status != "running" || expectServer.isEmpty())
        return "";
    obs_service_t *svc = obs_frontend_get_streaming_service();  // borrowed
    const char *type = svc ? obs_service_get_type(svc) : nullptr;
    if (!type || strcmp(type, "rtmp_custom") != 0)
        return "OBS's stream output isn't on SlimCast. Stop and press Go Live again.";
    obs_data_t *s = obs_service_get_settings(svc);
    const QString curServer = QString::fromUtf8(obs_data_get_string(s, "server"));
    const QString curKey = QString::fromUtf8(obs_data_get_string(s, "key"));
    obs_data_release(s);
    if (curKey != expectKey || curServer != expectServer)
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

// ── One-click OBS auto-configuration ──────────────────────────────────────────

// Detect the platform + best HEVC encoder, confirm with the user, then write
// SlimCast's recommended encoder settings into the active OBS profile.
void RelayDock::onAutoConfigure()
{
    // Changing the output mode/encoder mid-stream would tear the running output
    // down — make the user stop first.
    if (obs_frontend_streaming_active()) {
        QMessageBox::information(this, "SlimCast",
            "Stop streaming first, then auto-configure your OBS settings.");
        return;
    }

    QString encId, encName;
    int bfFamily = BF_BF_INT;
    if (!pickHevcEncoder(encId, encName, bfFamily)) {
        QMessageBox::warning(this, "SlimCast — no HEVC encoder",
            "Couldn't find a hardware HEVC (H.265) encoder on this computer.\n\n"
            "SlimCast needs Apple VideoToolbox (Mac) or an NVIDIA / AMD / Intel "
            "HEVC encoder (PC). Your GPU or OS version may not support it.");
        return;
    }

#ifdef __APPLE__
    const QString platform = "Mac · Apple VideoToolbox";
#else
    const QString platform = "Windows";
#endif

    // The OBS→GPU ingest is the user's single upload, so target their configured
    // landscape cap (falls back to 6000 kbps before the encode config has loaded).
    const int bitrate = (m_haveEncode && m_encode.landscape > 0) ? m_encode.landscape : 6000;

    const QString summary = QString(
        "Detected: %1\nEncoder: %2\n\n"
        "SlimCast will change these OBS settings:\n"
        "  •  Stream service  →  Custom (SlimCast)\n"
        "  •  Output mode  →  Advanced\n"
        "  •  Encoder  →  %2 (HEVC)\n"
        "  •  Rate control  →  CBR @ %3 kbps\n"
        "  •  Dynamic bitrate  →  On\n"
        "  •  B-frames  →  Off\n"
        "  •  Keyframe interval  →  2s   ·   Profile  →  main\n\n"
        "Apply these now?")
        .arg(platform, encName).arg(bitrate);

    if (QMessageBox::question(this, "Auto-configure OBS for SlimCast", summary,
            QMessageBox::Yes | QMessageBox::No, QMessageBox::Yes) != QMessageBox::Yes)
        return;

    // OBS hot-applies streamEncoder.json (CBR, bitrate, keyframes, B-frames…) on
    // every Go Live, but it only rebuilds the output handler — and thus picks up a
    // new output MODE or a different encoder TYPE — at startup / profile load.
    // So a restart is needed only when we're switching the mode or the encoder
    // itself; pure setting tweaks take effect immediately.
    bool needsRestart = true;
    if (config_t *cfg = obs_frontend_get_profile_config()) {
        const char *mode = config_get_string(cfg, "Output", "Mode");
        const char *curEnc = config_get_string(cfg, "AdvOut", "Encoder");
        const bool wasAdvanced = mode && strcmp(mode, "Advanced") == 0;
        const bool sameEncoder = curEnc && encId == QString::fromUtf8(curEnc);
        needsRestart = !(wasAdvanced && sameEncoder);
    }

    applyRecommendedSettings(encId, bfFamily, bitrate);

    // Pure setting tweaks are hot-applied on the next Go Live, so nothing else to
    // do. A new output mode or encoder type only loads on an OBS rebuild, so when
    // that changed we restart OBS (the one reliable way to load it).
    if (!needsRestart)
        return;

    const auto choice = QMessageBox::question(this, "Restart OBS",
        "Your OBS settings are updated, but the new output mode / encoder only "
        "loads when OBS starts.\n\nRestart OBS now to apply them?",
        QMessageBox::Yes | QMessageBox::No, QMessageBox::Yes);
    if (choice == QMessageBox::Yes)
        restartObs();
}

// Persist the recommended encoder config to the active profile. Encoder-specific
// settings live in <profile>/streamEncoder.json; the encoder id, output mode and
// dynamic-bitrate flag live in the profile's basic config. The streaming service
// is switched to Custom, preserving any SlimCast URL/key already present (Go Live
// fills these in when it provisions a pod).
void RelayDock::applyRecommendedSettings(const QString &encId, int bfFamily, int bitrate)
{
    // 1) Encoder settings JSON — merge into any existing file so we don't wipe
    //    other tweaks the user may have set.
    if (char *profPathRaw = obs_frontend_get_current_profile_path()) {
        const QString jsonPath = QString::fromUtf8(profPathRaw) + "/streamEncoder.json";
        bfree(profPathRaw);

        obs_data_t *enc = obs_data_create_from_json_file(jsonPath.toUtf8().constData());
        if (!enc) enc = obs_data_create();
        obs_data_set_string(enc, "rate_control", "CBR");
        obs_data_set_int(enc, "bitrate", bitrate);
        obs_data_set_int(enc, "keyint_sec", 2);
        obs_data_set_string(enc, "profile", "main");
        // Disable B-frames using whichever key this encoder family reads.
        if (bfFamily == BF_VT_BOOL)      obs_data_set_bool(enc, "bframes", false);
        else if (bfFamily == BF_QSV_INT) obs_data_set_int(enc, "bframes", 0);
        else                             obs_data_set_int(enc, "bf", 0);
        obs_data_save_json_safe(enc, jsonPath.toUtf8().constData(), "tmp", "bak");
        obs_data_release(enc);
    }

    // 2) Profile config — output mode, encoder selection, dynamic bitrate.
    if (config_t *cfg = obs_frontend_get_profile_config()) {
        config_set_string(cfg, "Output", "Mode", "Advanced");
        config_set_string(cfg, "AdvOut", "Encoder", encId.toUtf8().constData());
        config_set_bool(cfg, "Output", "DynamicBitrate", true);
        config_set_bool(cfg, "AdvOut", "ApplyServiceSettings", false);  // keep our CBR/bitrate
        config_set_bool(cfg, "AdvOut", "Rescale", false);               // stream at canvas res
        config_save_safe(cfg, "tmp", nullptr);
    }

    // 3) Streaming service → Custom (SlimCast), preserving any URL/key already set.
    QString server, key;
    obs_service_t *svc = obs_frontend_get_streaming_service();   // borrowed
    const char *type = svc ? obs_service_get_type(svc) : nullptr;
    if (type && strcmp(type, "rtmp_custom") == 0) {
        obs_data_t *s = obs_service_get_settings(svc);
        server = QString::fromUtf8(obs_data_get_string(s, "server"));
        key    = QString::fromUtf8(obs_data_get_string(s, "key"));
        obs_data_release(s);
    }
    setSlimcastService(server, key);
}
