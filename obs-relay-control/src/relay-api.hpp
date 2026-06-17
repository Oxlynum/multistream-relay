#pragma once
#include <QObject>
#include <QNetworkAccessManager>
#include <QJsonObject>
#include <QJsonArray>
#include <functional>

// Thin async wrapper around the relay's FastAPI control plane.
// All results are delivered via signals on the Qt main thread.
class RelayApi : public QObject {
    Q_OBJECT

public:
    explicit RelayApi(QObject *parent = nullptr);

    void setEndpoint(const QString &baseUrl, const QString &token);
    bool hasEndpoint() const { return !m_baseUrl.isEmpty(); }

    void fetchConfig();
    void saveConfig(const QJsonObject &config);
    void sendControl(const QString &action, bool grace = false);
    void fetchStatus();
    void fetchLogs(const QString &outputName);

signals:
    void configLoaded(QJsonObject config);
    void configSaved();
    void controlAcked(QString action);
    void statusUpdated(QJsonArray outputs);
    void logsReceived(QString name, QStringList lines);
    void networkError(QString message);

private:
    QNetworkAccessManager *m_nam;
    QString m_baseUrl;
    QString m_token;

    QNetworkRequest makeRequest(const QString &path) const;
    void dispatch(QNetworkReply *reply,
                  std::function<void(const QByteArray &)> onSuccess);
};
