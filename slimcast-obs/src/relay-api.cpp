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

void RelayApi::fetchGpuStatus()
{
    dispatch(m_nam->get(makeRequest("/api/gpu/status")), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (!doc.isObject()) return;
        auto obj = doc.object();
        GpuInfo info;
        info.status        = obj["status"].toString("stopped");
        info.ip            = obj["ip"].toString();
        info.rtmpUrl       = obj["rtmp_url"].toString();
        info.creditsSeconds = obj["credits_seconds"].toInt(0);
        emit gpuStatusUpdated(info);
    });
}

void RelayApi::provisionGpu()
{
    QByteArray empty("{}");
    dispatch(m_nam->post(makeRequest("/api/gpu/provision"), empty),
        [this](const QByteArray &) {
            emit gpuProvisioned();
        }
    );
}

void RelayApi::stopGpu()
{
    QByteArray empty("{}");
    dispatch(m_nam->post(makeRequest("/api/gpu/stop"), empty),
        [this](const QByteArray &) {
            emit gpuStopped();
        }
    );
}

void RelayApi::sendControl(const QString &command)
{
    QJsonObject body{{"command", command}};
    dispatch(
        m_nam->post(makeRequest("/api/agent/control"), QJsonDocument(body).toJson()),
        [this, command](const QByteArray &) {
            emit controlSent(command);
        }
    );
}

void RelayApi::fetchCredits()
{
    dispatch(m_nam->get(makeRequest("/api/credits/balance")), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (!doc.isObject()) return;
        emit creditsUpdated(doc.object()["seconds"].toInt(0));
    });
}
