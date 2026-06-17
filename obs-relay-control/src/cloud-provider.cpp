#include "cloud-provider.hpp"
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QUrl>
#include <QSslConfiguration>

static constexpr int POLL_INTERVAL_MS = 5000;   // poll provider every 5 s
static constexpr int MAX_POLL_ATTEMPTS = 60;     // give up after ~5 min

CloudProvider::CloudProvider(QObject *parent)
    : QObject(parent)
    , m_nam(new QNetworkAccessManager(this))
    , m_pollTimer(new QTimer(this))
{
    m_pollTimer->setInterval(POLL_INTERVAL_MS);
    connect(m_pollTimer, &QTimer::timeout, this, &CloudProvider::onPollTimer);
}

void CloudProvider::configure(CloudProviderType type,
                               const QString &apiKey,
                               const QString &serverId,
                               int ingestPort,
                               int apiPort)
{
    m_type       = type;
    m_apiKey     = apiKey;
    m_serverId   = serverId.trimmed();
    m_ingestPort = ingestPort;
    m_apiPort    = apiPort;
    m_stopping   = false;
}

// ── public API ────────────────────────────────────────────────────────────────

void CloudProvider::startServer()
{
    m_stopping = false;
    emit statusChanged("starting");
    switch (m_type) {
    case CloudProviderType::RunPod:       runpodStart(); break;
    case CloudProviderType::DigitalOcean: doStart();     break;
    case CloudProviderType::Vultr:        vultrStart();  break;
    case CloudProviderType::Universal:
        // Universal: assume server is already up, just start polling relay
        m_pollTimer->start();
        break;
    }
}

void CloudProvider::stopServer()
{
    m_stopping = true;
    m_pollTimer->stop();
    emit statusChanged("stopping");
    switch (m_type) {
    case CloudProviderType::RunPod:       runpodStop(); break;
    case CloudProviderType::DigitalOcean: doStop();     break;
    case CloudProviderType::Vultr:        vultrStop();  break;
    case CloudProviderType::Universal:    emit statusChanged("stopped"); break;
    }
}

// ── poll timer ────────────────────────────────────────────────────────────────

void CloudProvider::onPollTimer()
{
    if (m_stopping) { m_pollTimer->stop(); return; }
    switch (m_type) {
    case CloudProviderType::RunPod:       runpodPoll(); break;
    case CloudProviderType::DigitalOcean: doPoll();     break;
    case CloudProviderType::Vultr:        vultrPoll();  break;
    case CloudProviderType::Universal:
        // For universal, we just poll the relay API directly.
        // Emit serverReady with whatever host/ports were configured in the dock.
        m_pollTimer->stop();
        emit statusChanged("running");
        // serverReady is emitted by the dock after relay connectivity is confirmed.
        break;
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

QNetworkRequest CloudProvider::makeRequest(const QString &url,
                                           const QString &bearerToken) const
{
    QNetworkRequest req((QUrl(url)));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    req.setTransferTimeout(15000);
    if (!bearerToken.isEmpty())
        req.setRawHeader("Authorization",
                         QByteArray("Bearer ") + bearerToken.toUtf8());
    return req;
}

void CloudProvider::dispatch(QNetworkReply *reply,
                             std::function<void(const QByteArray &)> onSuccess)
{
    connect(reply, &QNetworkReply::sslErrors, reply,
            qOverload<>(&QNetworkReply::ignoreSslErrors));
    connect(reply, &QNetworkReply::finished, this, [this, reply, onSuccess]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            emit providerError(reply->errorString());
            return;
        }
        onSuccess(reply->readAll());
    });
}

// ── RunPod ────────────────────────────────────────────────────────────────────

static const QString RUNPOD_GQL = "https://api.runpod.io/graphql";

void CloudProvider::runpodStart()
{
    QString query = R"({"query":"mutation { podResume(input:{podId:\"%1\",gpuCount:1}){id desiredStatus} }"})";
    query = query.arg(m_serverId);

    QString url = RUNPOD_GQL + "?api_key=" + QUrl::toPercentEncoding(m_apiKey);
    auto req = makeRequest(url);
    dispatch(m_nam->post(req, query.toUtf8()), [this](const QByteArray &) {
        m_pollTimer->start();
    });
}

void CloudProvider::runpodStop()
{
    QString query = R"({"query":"mutation { podStop(input:{podId:\"%1\"}){id desiredStatus} }"})";
    query = query.arg(m_serverId);

    QString url = RUNPOD_GQL + "?api_key=" + QUrl::toPercentEncoding(m_apiKey);
    auto req = makeRequest(url);
    dispatch(m_nam->post(req, query.toUtf8()), [this](const QByteArray &) {
        emit statusChanged("stopped");
    });
}

void CloudProvider::runpodPoll()
{
    // Query pod status and port mappings.
    QString query = R"({"query":"{ pod(input:{podId:\"%1\"}){ desiredStatus runtime{ ports{ ip isIpPublic privatePort publicPort type } } } }"})";
    query = query.arg(m_serverId);

    QString url = RUNPOD_GQL + "?api_key=" + QUrl::toPercentEncoding(m_apiKey);
    auto req = makeRequest(url);
    dispatch(m_nam->post(req, query.toUtf8()), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        auto pod = doc.object()["data"].toObject()["pod"].toObject();

        if (pod["desiredStatus"].toString() != "RUNNING") return;

        auto runtime = pod["runtime"].toObject();
        if (runtime.isEmpty()) return;  // booting, ports not assigned yet

        // Find the public IP and map private ports to public ports.
        QString host;
        int ingestPublic = 0, apiPublic = 0;

        for (const auto &v : runtime["ports"].toArray()) {
            auto p = v.toObject();
            if (!p["isIpPublic"].toBool()) continue;
            if (host.isEmpty()) host = p["ip"].toString();
            int priv = p["privatePort"].toInt();
            int pub  = p["publicPort"].toInt();
            if (priv == m_ingestPort) ingestPublic = pub;
            if (priv == m_apiPort)    apiPublic    = pub;
        }

        if (host.isEmpty() || ingestPublic == 0 || apiPublic == 0) return;

        m_pollTimer->stop();
        emit statusChanged("running");
        emit serverReady({host, ingestPublic, apiPublic});
    });
}

// ── DigitalOcean ──────────────────────────────────────────────────────────────

static const QString DO_BASE = "https://api.digitalocean.com/v2/droplets/";

void CloudProvider::doStart()
{
    QString url = DO_BASE + m_serverId + "/actions";
    QJsonObject body{{"type", "power_on"}};
    dispatch(m_nam->post(makeRequest(url, m_apiKey),
                         QJsonDocument(body).toJson()), [this](const QByteArray &) {
        m_pollTimer->start();
    });
}

void CloudProvider::doStop()
{
    QString url = DO_BASE + m_serverId + "/actions";
    QJsonObject body{{"type", "shutdown"}};
    dispatch(m_nam->post(makeRequest(url, m_apiKey),
                         QJsonDocument(body).toJson()), [this](const QByteArray &) {
        emit statusChanged("stopped");
    });
}

void CloudProvider::doPoll()
{
    dispatch(m_nam->get(makeRequest(DO_BASE + m_serverId, m_apiKey)),
             [this](const QByteArray &data) {
        auto droplet = QJsonDocument::fromJson(data).object()["droplet"].toObject();
        if (droplet["status"].toString() != "active") return;

        QString host;
        for (const auto &v : droplet["networks"].toObject()["v4"].toArray()) {
            auto net = v.toObject();
            if (net["type"].toString() == "public") {
                host = net["ip_address"].toString();
                break;
            }
        }
        if (host.isEmpty()) return;

        m_pollTimer->stop();
        emit statusChanged("running");
        emit serverReady({host, m_ingestPort, m_apiPort});
    });
}

// ── Vultr ─────────────────────────────────────────────────────────────────────

static const QString VULTR_BASE = "https://api.vultr.com/v2/instances/";

void CloudProvider::vultrStart()
{
    QString url = VULTR_BASE + m_serverId + "/start";
    dispatch(m_nam->post(makeRequest(url, m_apiKey), nullptr), [this](const QByteArray &) {
        m_pollTimer->start();
    });
}

void CloudProvider::vultrStop()
{
    QString url = VULTR_BASE + m_serverId + "/halt";
    dispatch(m_nam->post(makeRequest(url, m_apiKey), nullptr), [this](const QByteArray &) {
        emit statusChanged("stopped");
    });
}

void CloudProvider::vultrPoll()
{
    dispatch(m_nam->get(makeRequest(VULTR_BASE + m_serverId, m_apiKey)),
             [this](const QByteArray &data) {
        auto inst = QJsonDocument::fromJson(data).object()["instance"].toObject();
        if (inst["power_status"].toString() != "running") return;

        QString host = inst["main_ip"].toString();
        if (host.isEmpty() || host == "0.0.0.0") return;

        m_pollTimer->stop();
        emit statusChanged("running");
        emit serverReady({host, m_ingestPort, m_apiPort});
    });
}
