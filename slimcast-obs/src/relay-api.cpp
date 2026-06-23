#include "relay-api.hpp"
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QDateTime>
#include <QUrl>
#include <QUrlQuery>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QCryptographicHash>
#include <QRandomGenerator>
#include <QDesktopServices>
#include <QHostInfo>

// The base URL is the only deployment-time constant. Everything else is
// driven by the user's API key. No server IPs, no tokens, no provider config.
// NOTE: temporary dev/test domain — slimcast.com isn't owned yet. Switch back
// to https://slimcast.com once the domain is live.
static const QString BASE_URL = QStringLiteral("https://slimcast-oxlynum.vercel.app");

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
        info.ingestKey      = obj["ingest_key"].toString();
        info.creditsSeconds = obj["credits_seconds"].toInt(0);
        info.burnRate       = obj["burn_rate"].toDouble(0);
        info.streaming      = obj["streaming"].toBool(false);
        info.confirmRequired = obj["confirm_required"].toBool(false);
        const QString deadline = obj["confirm_deadline"].toString();
        info.confirmDeadlineMs = deadline.isEmpty()
            ? 0
            : QDateTime::fromString(deadline, Qt::ISODateWithMs).toMSecsSinceEpoch();

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
    // Provisioning includes the broker's capacity search + the pod boot, which
    // can take ~45s — so this request needs a much longer timeout than the
    // default. Success/failure is also surfaced so the dock can narrate it.
    QNetworkRequest req(QUrl(BASE_URL + "/api/gpu/provision"));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    req.setRawHeader("Authorization", ("Bearer " + m_apiKey).toUtf8());
    req.setTransferTimeout(120000);

    QNetworkReply *reply = m_nam->post(req, QByteArray("{}"));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        const QByteArray data = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            const QString err = QJsonDocument::fromJson(data).object()["error"].toString();
            emit gpuProvisionFailed(err.isEmpty() ? reply->errorString() : err);
            return;
        }
        emit gpuProvisioned();
    });
}

void RelayApi::destroyGpu()
{
    // DELETE tears the pod down entirely — no idle billing between streams.
    dispatch(m_nam->deleteResource(makeRequest("/api/gpu")),
        [this](const QByteArray &) { emit gpuDestroyed(); });
}

void RelayApi::confirmSession()
{
    // "Yes, still streaming" — pushes the 12h session deadline out another 12h.
    send("POST", "/api/agent/confirm-session", {}, [this] { fetchGpuStatus(); });
}

// ── Device linking (OAuth Authorization Code + PKCE) ───────────────────────────

static QString randBase64Url(int nbytes)
{
    QByteArray b(nbytes, 0);
    auto *rng = QRandomGenerator::system();   // OS CSPRNG
    for (int i = 0; i < nbytes; ++i)
        b[i] = static_cast<char>(rng->bounded(256));
    return QString::fromLatin1(
        b.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}

void RelayApi::cleanupLink()
{
    if (m_linkTimeout) { m_linkTimeout->stop(); m_linkTimeout->deleteLater(); m_linkTimeout = nullptr; }
    if (m_linkServer)  { m_linkServer->close(); m_linkServer->deleteLater();  m_linkServer = nullptr; }
}

void RelayApi::beginDeviceLink()
{
    cleanupLink();

    // PKCE: verifier is a random 43-char base64url string; challenge is its
    // base64url(SHA-256). state guards against a stray/forged callback.
    m_pkceVerifier = randBase64Url(32);
    m_linkState    = randBase64Url(16);
    const QString challenge = QString::fromLatin1(
        QCryptographicHash::hash(m_pkceVerifier.toUtf8(), QCryptographicHash::Sha256)
            .toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));

    // Loopback listener for the redirect (browser → http://127.0.0.1:<port>).
    m_linkServer = new QTcpServer(this);
    if (!m_linkServer->listen(QHostAddress::LocalHost, 0)) {
        emit deviceLinkFailed("Could not open a local port to receive the link.");
        cleanupLink();
        return;
    }
    const quint16 port = m_linkServer->serverPort();

    connect(m_linkServer, &QTcpServer::newConnection, this, [this]() {
        QTcpSocket *sock = m_linkServer->nextPendingConnection();
        if (!sock) return;
        connect(sock, &QTcpSocket::readyRead, this, [this, sock]() {
            const QByteArray reqLine = sock->readLine();           // "GET /callback?... HTTP/1.1"
            const QList<QByteArray> parts = reqLine.split(' ');
            QString code, state;
            if (parts.size() >= 2) {
                const QUrl url("http://127.0.0.1" + QString::fromUtf8(parts[1]));
                const QUrlQuery q(url);
                code  = q.queryItemValue("code");
                state = q.queryItemValue("state");
            }
            const bool ok = !code.isEmpty() && state == m_linkState;
            const QString html = ok
                ? "<h2>OBS connected.</h2><p>You can close this tab and return to OBS.</p>"
                : "<h2>Link failed.</h2><p>Please return to OBS and try again.</p>";
            sock->write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n");
            sock->write(("<html><body style='font-family:sans-serif;text-align:center;"
                         "margin-top:60px;color:#222'>" + html + "</body></html>").toUtf8());
            sock->flush();
            sock->disconnectFromHost();

            cleanupLink();
            if (ok) exchangeDeviceCode(code);
            else    emit deviceLinkFailed("The link response was invalid. Try again.");
        });
    });

    // Abandon the attempt if the user never finishes in the browser.
    m_linkTimeout = new QTimer(this);
    m_linkTimeout->setSingleShot(true);
    connect(m_linkTimeout, &QTimer::timeout, this, [this]() {
        cleanupLink();
        emit deviceLinkFailed("Link timed out. Click Connect to try again.");
    });
    m_linkTimeout->start(3 * 60 * 1000);

    // Hand the PKCE challenge + loopback port to the browser consent page.
    QUrl url(BASE_URL + "/link");
    QUrlQuery q;
    q.addQueryItem("challenge", challenge);
    q.addQueryItem("state", m_linkState);
    q.addQueryItem("port", QString::number(port));
    url.setQuery(q);
    QDesktopServices::openUrl(url);
}

void RelayApi::exchangeDeviceCode(const QString &code)
{
    QJsonObject body{
        {"code", code},
        {"verifier", m_pkceVerifier},
        {"device_name", QHostInfo::localHostName()},
    };
    // No bearer key yet — possession of code + verifier is the proof.
    QNetworkRequest req(QUrl(BASE_URL + "/api/link/token"));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    req.setTransferTimeout(10000);

    QNetworkReply *reply = m_nam->post(req, QJsonDocument(body).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        const QByteArray data = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            const QString serverErr = QJsonDocument::fromJson(data).object()["error"].toString();
            const int httpCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            const QString detail = !serverErr.isEmpty() ? serverErr
                                 : (httpCode ? QString("HTTP %1").arg(httpCode)
                                             : reply->errorString());
            emit deviceLinkFailed("Linking failed: " + detail);
            return;
        }
        const QString key = QJsonDocument::fromJson(data).object()["api_key"].toString();
        if (key.isEmpty()) {
            emit deviceLinkFailed("Linking failed — no key returned.");
            return;
        }
        m_pkceVerifier.clear();
        m_linkState.clear();
        setApiKey(key);
        emit deviceLinked(key);
    });
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
