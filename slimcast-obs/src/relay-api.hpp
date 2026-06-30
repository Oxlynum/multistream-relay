#pragma once
#include <QObject>
#include <QNetworkAccessManager>
#include <QJsonObject>
#include <QJsonArray>
#include <QMap>
#include <QList>
#include <functional>

class QTcpServer;
class QTimer;

struct GpuInfo {
    QString status;            // "provisioning" | "running" | "stopped"
    QString ip;
    QString rtmpUrl;           // rtmp://{ip}:{port} — readiness beacon only; OBS never publishes here
    QString srtUrl;            // srt://{ip}:{port}?streamid=publish:{key} — the only ingest URL OBS uses
    QString ingestKey;         // per-pod ingest path secret (rides in the SRT streamid)
    QString datacenter;        // placement label (Vast offer label, e.g. "vast:123 … California, US")
    double  creditsTokens = 0; // balance in tokens (3dp)
    double  burnRate      = 0; // tokens/hr
    bool    streaming     = false;
    bool    confirmRequired  = false;
    qint64  confirmDeadlineMs = 0;
    QMap<QString, QString> platformStates;
    // ── Budget throttle ────────────────────────────────────────────────────────
    // When the pod's cost controller throttles, it asks the plugin to lower the OBS
    // encoder bitrate — the only lever that cuts both ingress and YouTube passthrough
    // egress. suggestedIngestKbps <= 0 means "no throttle, leave the encoder alone".
    int     suggestedIngestKbps = 0;
    bool    throttleActive = false;
    int     throttleTier   = 0;
    double  costUsdHr      = 0;   // live infra cost shown in the dock banner
    // True when this stream transcodes via a GPU backend behind the VPS hub — enables
    // the health graph's "GPU bridge" (VPS↔GPU) series. False for all-in-one/passthrough.
    bool    hasBridge      = false;
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

    // Browser-based device linking (OAuth Authorization Code + PKCE). Opens the
    // system browser to /link and listens on a 127.0.0.1 loopback for the code,
    // then exchanges it for a per-device key — no key is ever pasted.
    void beginDeviceLink();

    // GPU lifecycle.
    void fetchGpuStatus();
    void provisionGpu();
    void cancelProvision();  // abort in-flight provision request (then destroyGpu)
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
    void gpuProvisionFailed(QString reason);   // broker found no capacity, etc.
    void gpuDestroyed();
    void platformsUpdated(QList<PlatformConfig> platforms);
    void encodeUpdated(EncodeConfig encode);
    void networkError(QString message);
    void deviceLinked(QString apiKey);     // device link succeeded → raw key
    void deviceLinkFailed(QString message);

private:
    QNetworkAccessManager *m_nam;
    QString m_apiKey;

    QNetworkReply *m_provisionReply = nullptr;  // tracked so cancelProvision() can abort it

    // ── Device-link (PKCE) state ──────────────────────────────────────────────
    QTcpServer *m_linkServer = nullptr;
    QTimer     *m_linkTimeout = nullptr;
    QString     m_pkceVerifier;
    QString     m_linkState;
    void cleanupLink();
    void exchangeDeviceCode(const QString &code);

    QNetworkRequest makeRequest(const QString &path) const;
    void dispatch(QNetworkReply *reply,
                  std::function<void(const QByteArray &)> onSuccess);
    void send(const QByteArray &verb, const QString &path, const QJsonObject &body,
              std::function<void()> onOk);
};
