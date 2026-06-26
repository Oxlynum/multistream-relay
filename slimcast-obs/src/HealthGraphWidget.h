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

private slots:
    void onTimer();
    void onSelectorChanged(int index);

private:
    void fetchMetrics();
    void pushToCanvas();
    void updateChips();

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
    QString          m_selectedKey;   // "" = inbound (SlimCast), else platform id
    bool             m_streaming   = false;
    QStringList      m_platforms;
    QList<DataPoint> m_points;
};
