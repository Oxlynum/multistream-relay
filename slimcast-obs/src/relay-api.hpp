#pragma once
#include <QObject>
#include <QNetworkAccessManager>
#include <QJsonObject>
#include <QJsonArray>
#include <functional>

struct GpuInfo {
    QString status;       // "provisioning" | "running" | "stopped" | "error"
    QString ip;           // populated when running
    QString rtmpUrl;      // rtmp://{ip}:1935/live
    int     creditsSeconds = 0;
};

// All communication with slimcast.com. Base URL is compiled in; API key is
// set once by the user and persisted in QSettings.
class RelayApi : public QObject {
    Q_OBJECT

public:
    explicit RelayApi(QObject *parent = nullptr);

    void setApiKey(const QString &key);
    bool hasApiKey() const { return !m_apiKey.isEmpty(); }

    void fetchGpuStatus();
    void provisionGpu();
    void stopGpu();
    void sendControl(const QString &command);   // "start" | "stop"
    void fetchCredits();

signals:
    void gpuStatusUpdated(GpuInfo info);
    void gpuProvisioned();
    void gpuStopped();
    void controlSent(QString command);
    void creditsUpdated(int seconds);
    void networkError(QString message);

private:
    QNetworkAccessManager *m_nam;
    QString m_apiKey;

    QNetworkRequest makeRequest(const QString &path) const;
    void dispatch(QNetworkReply *reply,
                  std::function<void(const QByteArray &)> onSuccess);
};
