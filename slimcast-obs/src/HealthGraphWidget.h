#pragma once

#include <QWidget>
#include <QComboBox>
#include <QLabel>
#include <QTimer>
#include <QNetworkAccessManager>
#include <QString>
#include <QStringList>
#include <QList>

class GraphCanvas;

// Connection health graph panel for the Health tab of the SlimCast dock.
// Shows a rolling sparkline of ingest bitrate (blue) and health score (green)
// for the selected source. Updates every 5 s while streaming.
class HealthGraphWidget : public QWidget {
    Q_OBJECT

public:
    explicit HealthGraphWidget(QWidget *parent = nullptr);

    void setApiKey(const QString &key);
    void setActivePlatforms(const QStringList &platforms);
    void setStreaming(bool streaming);

private slots:
    void onTimer();

private:
    void fetchMetrics();
    void rebuildCombo();
    void pushToCanvas();

    static constexpr int MAX_POINTS = 60;

    struct DataPoint {
        double bitrateKbps = 0;
        double healthScore  = 0;
    };

    struct Source {
        QString label;        // "OBS → SlimCast" | "→ Twitch" etc.
        QString key;          // "" = overall ingest, else platform id
        QList<DataPoint> pts;
    };

    QComboBox             *m_combo       = nullptr;
    GraphCanvas           *m_canvas      = nullptr;
    QLabel                *m_bitrateChip = nullptr;
    QLabel                *m_healthChip  = nullptr;
    QNetworkAccessManager *m_nam         = nullptr;
    QTimer                *m_timer       = nullptr;

    QString     m_apiKey;
    bool        m_streaming = false;
    QStringList m_platforms;
    QList<Source> m_sources;
    int         m_selected  = 0;
};
