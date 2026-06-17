#pragma once
#include <QObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QTimer>
#include <QString>
#include <functional>

enum class CloudProviderType { RunPod, DigitalOcean, Vultr, Universal };

// Resolved network coordinates of a running server.
struct ServerInfo {
    QString host;
    int ingestPort = 0;
    int apiPort    = 0;
};

// Manages start/stop/poll for one cloud server.
// All results are delivered via signals on the Qt main thread.
class CloudProvider : public QObject {
    Q_OBJECT

public:
    explicit CloudProvider(QObject *parent = nullptr);

    void configure(CloudProviderType type,
                   const QString &apiKey,
                   const QString &serverId,
                   int ingestPort,
                   int apiPort);

    void startServer();
    void stopServer();

signals:
    void statusChanged(const QString &status);   // "starting" | "running" | "stopping" | "stopped"
    void serverReady(ServerInfo info);            // emitted once relay is reachable
    void providerError(QString message);

private slots:
    void onPollTimer();

private:
    // ── RunPod (GraphQL) ──────────────────────────────────────────────────────
    void runpodStart();
    void runpodStop();
    void runpodPoll();

    // ── DigitalOcean (REST) ───────────────────────────────────────────────────
    void doStart();
    void doStop();
    void doPoll();

    // ── Vultr (REST) ──────────────────────────────────────────────────────────
    void vultrStart();
    void vultrStop();
    void vultrPoll();

    void dispatch(QNetworkReply *reply,
                  std::function<void(const QByteArray &)> onSuccess);

    QNetworkRequest makeRequest(const QString &url,
                                const QString &bearerToken = {}) const;

    QNetworkAccessManager *m_nam;
    QTimer                *m_pollTimer;

    CloudProviderType m_type     = CloudProviderType::RunPod;
    QString           m_apiKey;
    QString           m_serverId;
    int               m_ingestPort = 1935;
    int               m_apiPort    = 8080;
    bool              m_stopping   = false;
};
