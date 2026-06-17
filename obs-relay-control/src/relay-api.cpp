#include "relay-api.hpp"
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QUrl>
#include <QSslConfiguration>

RelayApi::RelayApi(QObject *parent)
    : QObject(parent)
    , m_nam(new QNetworkAccessManager(this))
{
}

void RelayApi::setEndpoint(const QString &baseUrl, const QString &token)
{
    m_baseUrl = baseUrl;
    m_token   = token;
}

QNetworkRequest RelayApi::makeRequest(const QString &path) const
{
    QString url = m_baseUrl + "/api" + path;
    if (!m_token.isEmpty())
        url += "?token=" + QString::fromUtf8(QUrl::toPercentEncoding(m_token));
    QNetworkRequest req((QUrl(url)));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    req.setTransferTimeout(8000);
    return req;
}

void RelayApi::dispatch(QNetworkReply *reply,
                        std::function<void(const QByteArray &)> onSuccess)
{
    // Accept self-signed certs — the relay generates one on first run since
    // cloud GPU servers don't have domain names for Let's Encrypt.
    // Traffic is still encrypted against passive eavesdropping.
    connect(reply, &QNetworkReply::sslErrors, reply,
            qOverload<>(&QNetworkReply::ignoreSslErrors));

    connect(reply, &QNetworkReply::finished, this, [this, reply, onSuccess]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            emit networkError(reply->errorString());
            return;
        }
        onSuccess(reply->readAll());
    });
}

void RelayApi::fetchConfig()
{
    dispatch(m_nam->get(makeRequest("/config")), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (doc.isObject())
            emit configLoaded(doc.object());
    });
}

void RelayApi::saveConfig(const QJsonObject &config)
{
    dispatch(
        m_nam->post(makeRequest("/config"), QJsonDocument(config).toJson()),
        [this](const QByteArray &) { emit configSaved(); }
    );
}

void RelayApi::sendControl(const QString &action, bool grace)
{
    QJsonObject body{{"action", action}, {"grace", grace}};
    dispatch(
        m_nam->post(makeRequest("/control"), QJsonDocument(body).toJson()),
        [this, action](const QByteArray &) { emit controlAcked(action); }
    );
}

void RelayApi::fetchStatus()
{
    dispatch(m_nam->get(makeRequest("/status")), [this](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (doc.isObject())
            emit statusUpdated(doc.object()["outputs"].toArray());
    });
}

void RelayApi::fetchLogs(const QString &outputName)
{
    QString enc = QString::fromUtf8(QUrl::toPercentEncoding(outputName));
    dispatch(m_nam->get(makeRequest("/logs/" + enc)), [this, outputName](const QByteArray &data) {
        auto doc = QJsonDocument::fromJson(data);
        if (!doc.isObject()) return;
        QStringList lines;
        for (const auto &v : doc.object()["lines"].toArray())
            lines << v.toString();
        emit logsReceived(outputName, lines);
    });
}
