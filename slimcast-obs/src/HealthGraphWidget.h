#pragma once

#include <QWidget>
#include <QComboBox>
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
    // Show/hide the "GPU bridge" (VPS↔GPU) series — on only for transcode-via-hub streams.
    void setBridgeAvailable(bool available);

private slots:
    void onTimer();
    void onSelectorChanged(int index);

private:
    void fetchMetrics();
    void pushToCanvas();
    void updateChips();
    void rebuildSelector();   // rebuilds: SlimCast + (bridge?) + platforms, preserving selection

    struct DataPoint {
        double bitrateKbps   = 0;
        double healthScore   = 0;
        int    droppedFrames = 0;
    };

    GraphCanvas           *m_canvas      = nullptr;
    QComboBox             *m_selector    = nullptr;
    QHBoxLayout           *m_chipsLayout = nullptr;
    QNetworkAccessManager *m_nam         = nullptr;
    QTimer                *m_timer       = nullptr;

    QString          m_apiKey;
    QString          m_selectedKey;   // "" = inbound (SlimCast), "__bridge__" = bridge, else platform id
    bool             m_streaming   = false;
    bool             m_bridgeAvailable = false;
    QStringList      m_platforms;
    QList<DataPoint> m_points;
};
