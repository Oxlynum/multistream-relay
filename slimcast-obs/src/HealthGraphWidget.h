#pragma once

#include <QWidget>
#include <QHBoxLayout>
#include <QTimer>
#include <QNetworkAccessManager>
#include <QString>
#include <QStringList>
#include <QList>

class GraphCanvas;

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
    void rebuildSources();
    void pushToCanvas();
    void updateChips();

    static constexpr int MAX_POINTS = 60;

    struct DataPoint {
        double bitrateKbps = 0;
        double healthScore  = 0;
    };

    struct Source {
        QString label;
        QString key;   // "" = ingest, else platform id
        QList<DataPoint> pts;
    };

    GraphCanvas           *m_canvas      = nullptr;
    QHBoxLayout           *m_chipsLayout = nullptr;
    QNetworkAccessManager *m_nam         = nullptr;
    QTimer                *m_timer       = nullptr;

    QString       m_apiKey;
    bool          m_streaming = false;
    QStringList   m_platforms;
    QList<Source> m_sources;
};
