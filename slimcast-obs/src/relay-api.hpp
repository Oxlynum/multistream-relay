#pragma once
#include <QObject>
#include <QNetworkAccessManager>
#include <QJsonObject>
#include <QJsonArray>
#include <QMap>
#include <QList>
#include <functional>

struct GpuInfo {
    QString status;            // "provisioning" | "running" | "stopped"
    QString ip;                // populated when running
    QString rtmpUrl;           // rtmp://{ip}:1935/live
    int     creditsSeconds = 0;
    double  burnRate       = 0; // tokens/hr (== credit-seconds/sec); $2/token
    bool    streaming      = false;
    // "Still streaming?" prompt: set in the final 30m of the 12h session cap.
    bool    confirmRequired = false;
    qint64  confirmDeadlineMs = 0; // epoch ms of max_session_at (0 = none)
    // platform id ("twitch","kick","youtube","tiktok") -> output state
    // ("running","restarting","error",…). Absent = idle.
    QMap<QString, QString> platformStates;
};

// A user's connected channel. Stream keys/URLs never leave the server — the dock
// only sees which channels exist, their orientation, and whether they're on.
struct PlatformConfig {
    QString platform;
    QString orientation = "landscape";
    bool    enabled     = false;
};

// Per-encode-group bitrate caps + the rails the UI clamps to.
struct EncodeConfig {
    int landscape    = 6000;
    int portrait     = 4000;
    int landscapeMin = 2500, landscapeMax = 8000;
    int portraitMin  = 1000, portraitMax  = 4500;
};

// All communication with slimcast.com. Base URL is compiled in; the API key is
// set once by the user and persisted in QSettings. GPU lifecycle is OBS-driven
// (provision on Start Streaming, destroy on Stop). Channel toggles + bitrate caps
// write the same Supabase rows the website does, so dock and web stay in sync.
class RelayApi : public QObject {
    Q_OBJECT

public:
    explicit RelayApi(QObject *parent = nullptr);

    void setApiKey(const QString &key);
    bool hasApiKey() const { return !m_apiKey.isEmpty(); }

    // GPU lifecycle.
    void fetchGpuStatus();
    void provisionGpu();
    void destroyGpu();
    void confirmSession();   // "Yes, still streaming" — extends the 12h deadline

    // Channel + encode config (shared with the website).
    void fetchPlatforms();
    void setPlatformEnabled(const QString &platform, bool enabled);
    void fetchEncode();
    void setEncode(int landscapeKbps, int portraitKbps);

signals:
    void gpuStatusUpdated(GpuInfo info);
    void gpuProvisioned();
    void gpuDestroyed();
    void platformsUpdated(QList<PlatformConfig> platforms);
    void encodeUpdated(EncodeConfig encode);
    void networkError(QString message);

private:
    QNetworkAccessManager *m_nam;
    QString m_apiKey;

    QNetworkRequest makeRequest(const QString &path) const;
    void dispatch(QNetworkReply *reply,
                  std::function<void(const QByteArray &)> onSuccess);
    void send(const QByteArray &verb, const QString &path, const QJsonObject &body,
              std::function<void()> onOk);
};
