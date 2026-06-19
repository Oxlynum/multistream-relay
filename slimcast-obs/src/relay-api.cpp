#include "relay-api.hpp"
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QUrl>

// The base URL is the only deployment-time constant. Everything else is
// driven by the user's API key. No server IPs, no tokens, no provider config.
static const QString BASE_URL = QStringLiteral("https://slimcast.com");

RelayApi::RelayApi(QObject *parent)
    : QObject(parent)
    , m_nam(new QNetworkAccessManager(this))
{
}

void RelayApi::setApiKey(const QString &key)
{
    m_apiKey = key.trimmed();
}

QNetworkRequest RelayApi::makeRequest(const QString &path) const
{
    QNetworkRequest req(QUrl(BASE_URL + path));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    req.setRawHeader("Authorization", ("Bearer " + m_apiKey).toUtf8());
    req.setTransferTimeout(10000);
    return req;
}

void RelayApi::dispatch(QNetworkReply *reply,
                        std::function<void(const QByteArray &)> onSuccess)
{
    connect(reply, &QNetworkReply::finished, this, [this, reply, onSuccess]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            emit networkError(reply->errorString());
            return;
        }
        onSuccess(reply->readAll());
    });
}

// Generic verb sender (PATCH has no QNAM shortcut) with a fire-and-forget callback.
void RelayApi::send(const QByteArray &verb, const QString &path,
                    const QJsonObject &body, std::function<void()> onOk)
{
    QNetworkReply *reply = m_nam->sendCustomRequest(
        makeRequest(path), verb, QJsonDocument(body).toJson());
    dispatch(reply, [onOk](const QByteArray &) { onOk(); });
}

// ── GPU lifecycle ─────────────────────────────────────────────────────────────

void RelayApi::fetchGpuStatus()
{
    dispatch(m_nam->get(makeRequest("/api/gpu/status")), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (!doc.isObject()) return;
        auto obj = doc.object();

        GpuInfo info;
        info.status         = obj["status"].toString("stopped");
        info.ip             = obj["ip"].toString();
        info.rtmpUrl        = obj["rtmp_url"].toString();
        info.creditsSeconds = obj["credits_seconds"].toInt(0);
        info.burnRate       = obj["burn_rate"].toDouble(0);
        info.streaming      = obj["streaming"].toBool(false);

        for (const QJsonValue &v : obj["outputs"].toArray()) {
            auto o = v.toObject();
            const QString state = o["state"].toString();
            for (const QJsonValue &p : o["platforms"].toArray())
                info.platformStates[p.toString()] = state;
        }

        emit gpuStatusUpdated(info);
    });
}

void RelayApi::provisionGpu()
{
    dispatch(m_nam->post(makeRequest("/api/gpu/provision"), QByteArray("{}")),
        [this](const QByteArray &) { emit gpuProvisioned(); });
}

void RelayApi::destroyGpu()
{
    // DELETE tears the pod down entirely — no idle billing between streams.
    dispatch(m_nam->deleteResource(makeRequest("/api/gpu")),
        [this](const QByteArray &) { emit gpuDestroyed(); });
}

// ── Channel + encode config ───────────────────────────────────────────────────

void RelayApi::fetchPlatforms()
{
    dispatch(m_nam->get(makeRequest("/api/platforms")), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (!doc.isObject()) return;
        QList<PlatformConfig> list;
        for (const QJsonValue &v : doc.object()["platforms"].toArray()) {
            auto o = v.toObject();
            PlatformConfig p;
            p.platform    = o["platform"].toString();
            p.orientation = o["orientation"].toString("landscape");
            p.enabled     = o["enabled"].toBool(false);
            list.append(p);
        }
        emit platformsUpdated(list);
    });
}

void RelayApi::setPlatformEnabled(const QString &platform, bool enabled)
{
    send("PATCH", "/api/platforms/" + platform, {{"enabled", enabled}},
         [this] { fetchPlatforms(); });
}

void RelayApi::fetchEncode()
{
    dispatch(m_nam->get(makeRequest("/api/encode")), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (!doc.isObject()) return;
        auto obj = doc.object();
        EncodeConfig e;
        e.landscape = obj["landscape_bitrate_kbps"].toInt(6000);
        e.portrait  = obj["portrait_bitrate_kbps"].toInt(4000);
        auto lim = obj["limits"].toObject();
        auto l = lim["landscape"].toObject();
        auto p = lim["portrait"].toObject();
        e.landscapeMin = l["min"].toInt(2500); e.landscapeMax = l["max"].toInt(8000);
        e.portraitMin  = p["min"].toInt(1000); e.portraitMax  = p["max"].toInt(4500);
        emit encodeUpdated(e);
    });
}

void RelayApi::setEncode(int landscapeKbps, int portraitKbps)
{
    send("PATCH", "/api/encode",
         {{"landscape_bitrate_kbps", landscapeKbps}, {"portrait_bitrate_kbps", portraitKbps}},
         [] {});
}
