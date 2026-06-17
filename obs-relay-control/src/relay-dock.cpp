#include "relay-dock.hpp"
#include "provider-presets.hpp"
#include "cloud-provider.hpp"

#include <obs-module.h>
#include <obs-frontend-api.h>

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QGroupBox>
#include <QTabWidget>
#include <QScrollArea>
#include <QFrame>
#include <QJsonArray>
#include <QScrollBar>
#include <QSettings>

// ── helpers ───────────────────────────────────────────────────────────────────

static QComboBox *makeFpsCombo(QWidget *parent)
{
    auto *c = new QComboBox(parent);
    for (int fps : {60, 50, 48, 30})
        c->addItem(QString::number(fps));
    return c;
}

static QSpinBox *makeBitrateSpinBox(QWidget *parent, int defaultKbps)
{
    auto *s = new QSpinBox(parent);
    s->setRange(1000, 50000);
    s->setSingleStep(500);
    s->setValue(defaultKbps);
    s->setSuffix(" kbps");
    return s;
}

// Color map for the status dot. Keys match the relay supervisor's state strings.
static QString stateColor(const QString &state)
{
    if (state == "running")    return "#37d67a";
    if (state == "restarting") return "#ffb020";
    if (state == "error")      return "#ff5470";
    return "#8b94a7"; // stopped / unknown
}

// ── ctor ─────────────────────────────────────────────────────────────────────

RelayDock::RelayDock(QWidget *parent)
    : QDockWidget(parent)
    , m_cloud(new CloudProvider(this))
    , m_api(new RelayApi(this))
    , m_pollTimer(new QTimer(this))
{
    setObjectName("RelayControlDock");
    setWindowTitle("Relay Control");

    buildUi();
    loadSettings();

    connect(m_api, &RelayApi::statusUpdated, this, &RelayDock::onStatusUpdated);
    connect(m_api, &RelayApi::configLoaded,  this, &RelayDock::onConfigLoaded);
    connect(m_api, &RelayApi::networkError,  this, &RelayDock::onApiError);

    connect(m_pollTimer, &QTimer::timeout, m_api, &RelayApi::fetchStatus);
    m_pollTimer->start(3000);

    connect(m_cloud, &CloudProvider::statusChanged, this, &RelayDock::onCloudStatusChanged);
    connect(m_cloud, &CloudProvider::serverReady,   this, &RelayDock::onCloudServerReady);
    connect(m_cloud, &CloudProvider::providerError, this, [this](const QString &msg) {
        m_cloudStatus->setText("Error: " + msg);
        m_cloudStatus->setStyleSheet("color:#ff5470");
    });
}

// ── UI construction ───────────────────────────────────────────────────────────

void RelayDock::buildUi()
{
    auto *root   = new QWidget(this);
    auto *rootLy = new QVBoxLayout(root);
    rootLy->setContentsMargins(4, 4, 4, 4);
    rootLy->setSpacing(4);

    auto *tabs = new QTabWidget(root);

    // ── Server tab ──────────────────────────────────────────────────────────
    {
        auto *w  = new QWidget;
        auto *fl = new QFormLayout(w);
        fl->setContentsMargins(8, 8, 8, 8);
        fl->setSpacing(6);

        m_provider = new QComboBox;
        for (const auto &p : providerPresets()) {
            m_provider->addItem(p.name);
            m_provider->setItemData(m_provider->count() - 1, p.note, Qt::ToolTipRole);
        }
        fl->addRow("Provider", m_provider);

        m_host = new QLineEdit;
        m_host->setPlaceholderText("123.45.67.89");
        fl->addRow("Server IP", m_host);

        m_ingestPort = new QSpinBox;
        m_ingestPort->setRange(1, 65535);
        fl->addRow("Ingest port", m_ingestPort);

        m_apiPort = new QSpinBox;
        m_apiPort->setRange(1, 65535);
        m_apiPort->setValue(8080);
        fl->addRow("API port", m_apiPort);

        m_token = new QLineEdit;
        m_token->setEchoMode(QLineEdit::Password);
        m_token->setPlaceholderText("RELAY_TOKEN / password");
        fl->addRow("Auth token", m_token);

        m_connLabel = new QLabel("● Not connected");
        m_connLabel->setStyleSheet("color:gray");
        fl->addRow("", m_connLabel);

        auto *applyBtn = new QPushButton("Apply & Set OBS Stream URL");
        fl->addRow(applyBtn);
        connect(applyBtn, &QPushButton::clicked, this, &RelayDock::onApplyServer);

        connect(m_provider, QOverload<int>::of(&QComboBox::currentIndexChanged),
                this, &RelayDock::onProviderChanged);

        // ── Cloud power management ────────────────────────────────────────────
        auto *cloudBox = new QGroupBox("Server power management");
        auto *cloudFl  = new QFormLayout(cloudBox);
        cloudFl->setSpacing(4);
        fl->addRow(cloudBox);

        m_cloudAutoCtrl = new QCheckBox("Auto start/stop server with stream");
        cloudFl->addRow(m_cloudAutoCtrl);

        m_cloudProvider = new QComboBox;
        m_cloudProvider->addItem("RunPod");
        m_cloudProvider->addItem("DigitalOcean");
        m_cloudProvider->addItem("Vultr");
        m_cloudProvider->addItem("Universal (manual IP)");
        cloudFl->addRow("Cloud provider", m_cloudProvider);

        m_cloudApiKey = new QLineEdit;
        m_cloudApiKey->setEchoMode(QLineEdit::Password);
        m_cloudApiKey->setPlaceholderText("Provider API key");
        cloudFl->addRow("API key", m_cloudApiKey);

        m_cloudServerId = new QLineEdit;
        m_cloudServerId->setPlaceholderText("Pod / Droplet / Instance ID");
        cloudFl->addRow("Server ID", m_cloudServerId);

        m_cloudStatus = new QLabel("● Server status unknown");
        m_cloudStatus->setStyleSheet("color:gray");
        cloudFl->addRow(m_cloudStatus);

        auto *cloudBtnRow = new QHBoxLayout;
        m_cloudStartBtn = new QPushButton("▶ Start Server");
        m_cloudStopBtn  = new QPushButton("⏹ Stop Server");
        cloudBtnRow->addWidget(m_cloudStartBtn);
        cloudBtnRow->addWidget(m_cloudStopBtn);
        cloudFl->addRow(cloudBtnRow);

        connect(m_cloudStartBtn, &QPushButton::clicked, this, &RelayDock::onCloudStart);
        connect(m_cloudStopBtn,  &QPushButton::clicked, this, &RelayDock::onCloudStop);

        tabs->addTab(w, "Server");
    }

    // ── Platforms tab ────────────────────────────────────────────────────────
    {
        auto *scroll = new QScrollArea;
        auto *w      = new QWidget;
        auto *ly     = new QVBoxLayout(w);
        ly->setContentsMargins(8, 8, 8, 8);
        ly->setSpacing(8);

        auto addPlatGroup = [&](const QString &title) -> QFormLayout * {
            auto *gb = new QGroupBox(title);
            auto *fl = new QFormLayout(gb);
            fl->setSpacing(4);
            ly->addWidget(gb);
            return fl;
        };

        {
            auto *fl = addPlatGroup("Twitch  —  H.264 RTMP");
            m_twitchEn  = new QCheckBox("Enabled");
            m_twitchKey = new QLineEdit;
            m_twitchKey->setEchoMode(QLineEdit::Password);
            m_twitchKey->setPlaceholderText("live_xxxxxxxxxxxxxxxx");
            m_twitchBr  = makeBitrateSpinBox(w, 8000);
            m_twitchFps = makeFpsCombo(w);
            fl->addRow(m_twitchEn);
            fl->addRow("Stream key", m_twitchKey);
            fl->addRow("Bitrate",    m_twitchBr);
            fl->addRow("FPS",        m_twitchFps);
        }
        {
            auto *fl = addPlatGroup("Kick  —  H.264 RTMPS");
            m_kickEn  = new QCheckBox("Enabled");
            m_kickKey = new QLineEdit;
            m_kickKey->setEchoMode(QLineEdit::Password);
            m_kickKey->setPlaceholderText("sk_xxxxxxxxxxxxxxxxxx");
            m_kickBr  = makeBitrateSpinBox(w, 8000);
            m_kickFps = makeFpsCombo(w);
            fl->addRow(m_kickEn);
            fl->addRow("Stream key", m_kickKey);
            fl->addRow("Bitrate",    m_kickBr);
            fl->addRow("FPS",        m_kickFps);
        }
        {
            auto *fl = addPlatGroup("YouTube  —  HEVC passthrough HLS");
            m_ytEn  = new QCheckBox("Enabled");
            m_ytUrl = new QLineEdit;
            m_ytUrl->setPlaceholderText(
                "https://a.upload.youtube.com/http_upload_hls?cid=YOUR_KEY...");
            fl->addRow(m_ytEn);
            fl->addRow("HLS ingest URL", m_ytUrl);
        }

        auto *saveBtn = new QPushButton("Save & Push to Relay");
        ly->addWidget(saveBtn);
        ly->addStretch();

        scroll->setWidget(w);
        scroll->setWidgetResizable(true);
        tabs->addTab(scroll, "Platforms");

        connect(saveBtn, &QPushButton::clicked, this, &RelayDock::onSavePlatforms);
    }

    // ── Status tab ──────────────────────────────────────────────────────────
    m_statusTab = new QWidget;
    new QVBoxLayout(m_statusTab);  // populated dynamically in onStatusUpdated
    tabs->addTab(m_statusTab, "Status");

    rootLy->addWidget(tabs, 1);

    // ── Bottom control strip ─────────────────────────────────────────────────
    auto *sep = new QFrame;
    sep->setFrameShape(QFrame::HLine);
    rootLy->addWidget(sep);

    auto *btnRow = new QHBoxLayout;
    m_startBtn   = new QPushButton("▶ Start");
    m_stopBtn    = new QPushButton("⏹ Stop");
    m_restartBtn = new QPushButton("↺ Restart");
    btnRow->addWidget(m_startBtn);
    btnRow->addWidget(m_stopBtn);
    btnRow->addWidget(m_restartBtn);
    rootLy->addLayout(btnRow);

    m_autoCtrl = new QCheckBox("Auto-control relay with OBS stream button");
    m_autoCtrl->setChecked(true);
    rootLy->addWidget(m_autoCtrl);

    m_globalStatus = new QLabel("—");
    m_globalStatus->setAlignment(Qt::AlignCenter);
    rootLy->addWidget(m_globalStatus);

    setWidget(root);

    connect(m_startBtn,   &QPushButton::clicked, this, &RelayDock::onStart);
    connect(m_stopBtn,    &QPushButton::clicked, this, &RelayDock::onStop);
    connect(m_restartBtn, &QPushButton::clicked, this, &RelayDock::onRestart);
}

// ── Settings persistence (OBS global config) ──────────────────────────────────

void RelayDock::loadSettings()
{
    QSettings s("obs-relay-control", "relay");
    int prov = s.value("providerIndex", 0).toInt();
    m_provider->setCurrentIndex(prov >= 0 && prov < m_provider->count() ? prov : 0);
    m_host->setText(s.value("host").toString());
    if (int v = s.value("ingestPort", 0).toInt(); v > 0) m_ingestPort->setValue(v);
    if (int v = s.value("apiPort",    0).toInt(); v > 0) m_apiPort->setValue(v);
    m_token->setText(s.value("token").toString());
    m_autoCtrl->setChecked(s.value("autoControl", true).toBool());

    m_cloudAutoCtrl->setChecked(s.value("cloudAutoControl", false).toBool());
    m_cloudProvider->setCurrentIndex(s.value("cloudProviderIndex", 0).toInt());
    m_cloudApiKey->setText(s.value("cloudApiKey").toString());
    m_cloudServerId->setText(s.value("cloudServerId").toString());

    m_twitchEn->setChecked(s.value("twitchEnabled", true).toBool());
    m_twitchKey->setText(s.value("twitchKey").toString());
    if (int v = s.value("twitchBitrate", 0).toInt(); v > 0) m_twitchBr->setValue(v);

    m_kickEn->setChecked(s.value("kickEnabled", true).toBool());
    m_kickKey->setText(s.value("kickKey").toString());
    if (int v = s.value("kickBitrate", 0).toInt(); v > 0) m_kickBr->setValue(v);

    m_ytEn->setChecked(s.value("youtubeEnabled", true).toBool());
    m_ytUrl->setText(s.value("youtubeUrl").toString());

    // Restore API endpoint if we have a host
    if (!m_host->text().isEmpty()) {
        m_api->setEndpoint(
            QString("https://%1:%2").arg(m_host->text()).arg(m_apiPort->value()),
            m_token->text()
        );
    }
}

void RelayDock::saveSettings()
{
    QSettings s("obs-relay-control", "relay");
    s.setValue("providerIndex",  m_provider->currentIndex());
    s.setValue("host",           m_host->text());
    s.setValue("ingestPort",     m_ingestPort->value());
    s.setValue("apiPort",        m_apiPort->value());
    s.setValue("token",          m_token->text());
    s.setValue("autoControl",       m_autoCtrl->isChecked());
    s.setValue("cloudAutoControl",  m_cloudAutoCtrl->isChecked());
    s.setValue("cloudProviderIndex",m_cloudProvider->currentIndex());
    s.setValue("cloudApiKey",       m_cloudApiKey->text());
    s.setValue("cloudServerId",     m_cloudServerId->text());
    s.setValue("twitchEnabled",     m_twitchEn->isChecked());
    s.setValue("twitchKey",      m_twitchKey->text());
    s.setValue("twitchBitrate",  m_twitchBr->value());
    s.setValue("kickEnabled",    m_kickEn->isChecked());
    s.setValue("kickKey",        m_kickKey->text());
    s.setValue("kickBitrate",    m_kickBr->value());
    s.setValue("youtubeEnabled", m_ytEn->isChecked());
    s.setValue("youtubeUrl",     m_ytUrl->text());
}

// ── Provider preset ───────────────────────────────────────────────────────────

void RelayDock::onProviderChanged(int index)
{
    const auto &presets = providerPresets();
    if (index < 0 || index >= presets.size()) return;
    m_ingestPort->setValue(presets[index].defaultIngestPort);
    m_apiPort->setValue(presets[index].defaultApiPort);
}

QString RelayDock::buildIngestUrl() const
{
    const auto &presets = providerPresets();
    int idx = m_provider->currentIndex();
    if (idx < 0 || idx >= presets.size()) return {};
    QString url = presets[idx].ingestUrlTemplate;
    url.replace("{host}", m_host->text().trimmed());
    url.replace("{port}", QString::number(m_ingestPort->value()));
    return url;
}

void RelayDock::applyObsStreamUrl()
{
    QString url = buildIngestUrl();
    if (url.isEmpty()) return;

    obs_service_t *svc = obs_frontend_get_streaming_service();
    if (!svc) return;

    obs_data_t *settings = obs_service_get_settings(svc);
    obs_data_set_string(settings, "server", url.toUtf8().constData());
    // "live" is the stream path MediaMTX listens on; the relay auth is
    // the token on the control API, not the RTMP stream key.
    obs_data_set_string(settings, "key", "live");
    obs_service_update(svc, settings);
    obs_data_release(settings);
    obs_service_release(svc);
    obs_frontend_save_streaming_service();
}

// ── Apply server settings ─────────────────────────────────────────────────────

void RelayDock::onApplyServer()
{
    QString host = m_host->text().trimmed();
    if (host.isEmpty()) {
        setConnLabel(false, "Enter a server IP first");
        return;
    }

    m_api->setEndpoint(
        QString("http://%1:%2").arg(host).arg(m_apiPort->value()),
        m_token->text()
    );
    applyObsStreamUrl();
    saveSettings();

    setConnLabel(false, "Connecting…");
    // Test connectivity by fetching status; onStatusUpdated fires on success
    m_api->fetchStatus();
    // Also pull existing config from the relay to populate platform fields
    m_api->fetchConfig();
}

void RelayDock::setConnLabel(bool ok, const QString &msg)
{
    if (ok) {
        m_connLabel->setText("● Connected");
        m_connLabel->setStyleSheet("color:#37d67a");
    } else {
        m_connLabel->setText("● " + (msg.isEmpty() ? QStringLiteral("Unreachable") : msg));
        m_connLabel->setStyleSheet(msg == "Connecting…" ? "color:gray" : "color:#ff5470");
    }
}

// ── Platform config ───────────────────────────────────────────────────────────

QJsonObject RelayDock::buildRelayConfig() const
{
    QJsonArray outputs;
    if (m_twitchEn->isChecked() || !m_twitchKey->text().isEmpty()) {
        outputs.append(QJsonObject{
            {"name",         "twitch"},
            {"enabled",      m_twitchEn->isChecked()},
            {"mode",         "transcode"},
            {"url",          "rtmp://live.twitch.tv/app"},
            {"key",          m_twitchKey->text()},
            {"bitrate_kbps", m_twitchBr->value()},
            {"width",        1920}, {"height", 1080},
            {"fps",          m_twitchFps->currentText().toInt()},
        });
    }
    if (m_kickEn->isChecked() || !m_kickKey->text().isEmpty()) {
        outputs.append(QJsonObject{
            {"name",         "kick"},
            {"enabled",      m_kickEn->isChecked()},
            {"mode",         "transcode"},
            {"url",          "rtmps://fa723fc1b171.global-contribute.live-video.net/app"},
            {"key",          m_kickKey->text()},
            {"bitrate_kbps", m_kickBr->value()},
            {"width",        1920}, {"height", 1080},
            {"fps",          m_kickFps->currentText().toInt()},
        });
    }
    if (m_ytEn->isChecked() || !m_ytUrl->text().isEmpty()) {
        outputs.append(QJsonObject{
            {"name",         "youtube"},
            {"enabled",      m_ytEn->isChecked()},
            {"mode",         "passthrough"},
            {"url",          m_ytUrl->text()},
            {"key",          ""},
            {"bitrate_kbps", 12000},
            {"width",        1920}, {"height", 1080},
            {"fps",          60},
        });
    }
    return QJsonObject{{"outputs", outputs}};
}

void RelayDock::onSavePlatforms()
{
    saveSettings();
    m_api->saveConfig(buildRelayConfig());
    m_globalStatus->setText("Saving platform config…");
}

// ── Manual pipeline controls ──────────────────────────────────────────────────

void RelayDock::onStart()   { m_api->sendControl("start"); }
void RelayDock::onRestart() { m_api->sendControl("restart"); }
void RelayDock::onStop()    { m_api->sendControl("stop", false); }

// ── OBS stream auto-control ───────────────────────────────────────────────────

void RelayDock::onObsStreamingStarting()
{
    if (m_cloudAutoCtrl->isChecked())
        onCloudStart();           // start server → onCloudServerReady starts relay
    else if (m_autoCtrl->isChecked())
        m_api->sendControl("start");
}

void RelayDock::onObsStreamingStopped()
{
    if (m_cloudAutoCtrl->isChecked()) {
        // grace=true so a quick OBS reconnect cancels the stop sequence
        m_api->sendControl("stop", /*grace=*/true);
        onCloudStop();
    } else if (m_autoCtrl->isChecked()) {
        m_api->sendControl("stop", /*grace=*/true);
    }
}

// ── Status updates ────────────────────────────────────────────────────────────

void RelayDock::onStatusUpdated(QJsonArray outputs)
{
    setConnLabel(true);

    auto *ly = qobject_cast<QVBoxLayout *>(m_statusTab->layout());

    // Rebuild layout rows whenever the set of outputs changes
    QStringList names;
    for (const auto &v : outputs) names << v.toObject()["name"].toString();

    // QMap::keys() is sorted alphabetically; compare as sets so row order from
    // the server doesn't trigger a spurious rebuild every poll cycle.
    QSet<QString> namesSet(names.begin(), names.end());
    QSet<QString> existingSet(m_statusRows.keyBegin(), m_statusRows.keyEnd());

    if (namesSet != existingSet) {
        // Clear existing rows
        while (ly->count()) {
            auto *item = ly->takeAt(0);
            if (item->widget()) item->widget()->deleteLater();
            delete item;
        }
        m_statusRows.clear();

        for (const QString &name : names) {
            auto *row  = new QWidget(m_statusTab);
            auto *rowL = new QHBoxLayout(row);
            rowL->setContentsMargins(0, 2, 0, 2);

            auto *dot   = new QLabel("●");
            dot->setFixedWidth(16);
            auto *lname = new QLabel(name);
            lname->setFixedWidth(72);
            auto *state = new QLabel("—");

            auto *logsBtn = new QPushButton("Logs");
            logsBtn->setFixedWidth(44);

            auto *logBox = new QPlainTextEdit(m_statusTab);
            logBox->setReadOnly(true);
            logBox->setMaximumHeight(80);
            logBox->hide();

            rowL->addWidget(dot);
            rowL->addWidget(lname);
            rowL->addWidget(state);
            rowL->addStretch();
            rowL->addWidget(logsBtn);

            ly->addWidget(row);
            ly->addWidget(logBox);

            connect(logsBtn, &QPushButton::clicked, this,
                [this, name, logBox, logsBtn] {
                    if (logBox->isVisible()) {
                        logBox->hide();
                        return;
                    }
                    logBox->show();
                    m_api->fetchLogs(name);
                    // Wire logs signal once — disconnect on next hide to avoid stacking
                    auto conn = connect(m_api, &RelayApi::logsReceived,
                        [logBox, name](const QString &n, const QStringList &lines) {
                            if (n != name) return;
                            logBox->setPlainText(lines.join('\n'));
                            logBox->verticalScrollBar()->setValue(
                                logBox->verticalScrollBar()->maximum());
                        });
                    connect(logsBtn, &QPushButton::clicked, this,
                        [this, conn] { disconnect(conn); }, Qt::SingleShotConnection);
                });

            m_statusRows[name] = {dot, state, logBox};
        }
        ly->addStretch();
    }

    // Update colors and state text
    QStringList live;
    for (const auto &v : outputs) {
        auto o    = v.toObject();
        auto name = o["name"].toString();
        auto st   = o["state"].toString();
        int  rst  = o["restarts"].toInt();

        if (!m_statusRows.contains(name)) continue;
        auto &row = m_statusRows[name];
        row.dot->setStyleSheet(QStringLiteral("color:%1").arg(stateColor(st)));

        QString label = st;
        if (rst > 0) label += QStringLiteral(" (%1 restart%2)").arg(rst).arg(rst > 1 ? "s" : "");
        row.state->setText(label);

        if (st == "running") live << name;
    }

    m_globalStatus->setText(live.isEmpty() ? "All stopped" : "Live: " + live.join(", "));
    m_globalStatus->setStyleSheet(live.isEmpty() ? "color:gray" : "color:#37d67a");
}

void RelayDock::onConfigLoaded(QJsonObject config)
{
    // Populate platform fields from relay's stored config. Stream keys typed in
    // the relay's web panel or saved here previously are shown in the dock.
    for (const auto &v : config["outputs"].toArray()) {
        auto o    = v.toObject();
        auto name = o["name"].toString();

        if (name == "twitch") {
            m_twitchEn->setChecked(o["enabled"].toBool(true));
            if (!o["key"].toString().isEmpty())
                m_twitchKey->setText(o["key"].toString());
            if (int br = o["bitrate_kbps"].toInt(); br > 0)
                m_twitchBr->setValue(br);
            int fps = o["fps"].toInt(60);
            int fi  = m_twitchFps->findText(QString::number(fps));
            if (fi >= 0) m_twitchFps->setCurrentIndex(fi);

        } else if (name == "kick") {
            m_kickEn->setChecked(o["enabled"].toBool(true));
            if (!o["key"].toString().isEmpty())
                m_kickKey->setText(o["key"].toString());
            if (int br = o["bitrate_kbps"].toInt(); br > 0)
                m_kickBr->setValue(br);
            int fps = o["fps"].toInt(60);
            int fi  = m_kickFps->findText(QString::number(fps));
            if (fi >= 0) m_kickFps->setCurrentIndex(fi);

        } else if (name == "youtube") {
            m_ytEn->setChecked(o["enabled"].toBool(true));
            if (!o["url"].toString().isEmpty())
                m_ytUrl->setText(o["url"].toString());
        }
    }
}

void RelayDock::onApiError(QString message)
{
    setConnLabel(false, message);
}

QWidget *RelayDock::buildStatusTab()
{
    return m_statusTab; // already constructed in buildUi()
}

// ── Cloud power management ────────────────────────────────────────────────────

static CloudProviderType indexToProviderType(int idx)
{
    switch (idx) {
    case 0: return CloudProviderType::RunPod;
    case 1: return CloudProviderType::DigitalOcean;
    case 2: return CloudProviderType::Vultr;
    default: return CloudProviderType::Universal;
    }
}

void RelayDock::onCloudStart()
{
    saveSettings();
    m_cloud->configure(
        indexToProviderType(m_cloudProvider->currentIndex()),
        m_cloudApiKey->text(),
        m_cloudServerId->text(),
        m_ingestPort->value(),
        m_apiPort->value()
    );
    m_cloud->startServer();
}

void RelayDock::onCloudStop()
{
    m_cloud->stopServer();
    m_api->sendControl("stop", false);
}

void RelayDock::onCloudStatusChanged(const QString &status)
{
    static const QMap<QString, QPair<QString, QString>> labels = {
        {"starting", {"● Starting server…", "color:#ffb020"}},
        {"running",  {"● Server running",   "color:#37d67a"}},
        {"stopping", {"● Stopping server…", "color:#ffb020"}},
        {"stopped",  {"● Server stopped",   "color:gray"}},
    };
    auto it = labels.find(status);
    if (it == labels.end()) return;
    m_cloudStatus->setText(it->first);
    m_cloudStatus->setStyleSheet(it->second);
}

void RelayDock::onCloudServerReady(ServerInfo info)
{
    // Update host/ports in the UI with what the provider reported.
    m_host->setText(info.host);
    m_ingestPort->setValue(info.ingestPort);
    m_apiPort->setValue(info.apiPort);

    // Re-point the relay API and OBS stream URL at the new coordinates.
    m_api->setEndpoint(
        QString("https://%1:%2").arg(info.host).arg(info.apiPort),
        m_token->text()
    );
    applyObsStreamUrl();
    saveSettings();

    // Start the relay pipeline on the server.
    m_api->fetchConfig();
    m_api->sendControl("start");
}
