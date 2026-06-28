#include "HealthGraphWidget.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QFont>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QUrl>
#include <QSizePolicy>
#include <algorithm>

static const QString BASE_URL = QStringLiteral("https://slimcast-oxlynum.vercel.app");

// ── GraphCanvas ───────────────────────────────────────────────────────────────

class GraphCanvas : public QWidget {
    Q_OBJECT
public:
    explicit GraphCanvas(QWidget *parent = nullptr) : QWidget(parent)
    {
        setMinimumHeight(180);
        setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
        setAutoFillBackground(false);
    }

    void setData(bool streaming, const QList<double> &bitrates, double currentHealth)
    {
        m_streaming     = streaming;
        m_bitrates      = bitrates;
        m_currentHealth = currentHealth;
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRect r = rect().adjusted(6, 6, -6, -6);
        p.fillRect(rect(), QColor(0x0f, 0x13, 0x1c));

        auto drawCenteredText = [&](const QString &text) {
            p.setPen(QColor(0x6b, 0x72, 0x80));
            QFont f = font();
            f.setPointSize(10);
            p.setFont(f);
            p.drawText(r, Qt::AlignCenter | Qt::TextWordWrap, text);
        };

        if (!m_streaming) {
            drawCenteredText("Start streaming to see connection health");
            return;
        }

        if (m_bitrates.size() < 2) {
            drawCenteredText("Waiting for data...");
            return;
        }

        // Line color from health score
        QColor lineColor;
        if (m_currentHealth < 0)       lineColor = QColor(0x8a, 0x93, 0xa3);
        else if (m_currentHealth >= 80) lineColor = QColor(0x10, 0xb9, 0x81); // green
        else if (m_currentHealth >= 50) lineColor = QColor(0xf5, 0x9e, 0x0b); // amber
        else                            lineColor = QColor(0xf4, 0x3f, 0x5e); // red

        // y-scale: max bitrate with 8% headroom
        double mx = 1.0;
        for (double v : m_bitrates)
            if (v > mx) mx = v;
        mx *= 1.08;

        const int    n     = m_bitrates.size();
        const double xStep = double(r.width()) / double(n - 1);

        QPolygon poly;
        for (int i = 0; i < n; ++i) {
            const int x = r.left() + int(i * xStep + 0.5);
            const int y = r.bottom() - int(m_bitrates[i] / mx * r.height() + 0.5);
            poly << QPoint(x, std::clamp(y, r.top(), r.bottom()));
        }

        QPen pen(lineColor);
        pen.setWidthF(1.8);
        p.setPen(pen);
        p.drawPolyline(poly);
    }

private:
    bool          m_streaming     = false;
    double        m_currentHealth = -1.0;
    QList<double> m_bitrates;
};

#include "HealthGraphWidget.moc"

// ── HealthGraphWidget ─────────────────────────────────────────────────────────

static QColor healthColor(double score)
{
    if (score < 0)       return QColor(0x8a, 0x93, 0xa3);
    if (score >= 80)     return QColor(0x10, 0xb9, 0x81);
    if (score >= 50)     return QColor(0xf5, 0x9e, 0x0b);
    return QColor(0xf4, 0x3f, 0x5e);
}

static QString chipStyle(const QColor &c)
{
    return QString(
        "background:rgba(%1,%2,%3,35); color:%4;"
        " border-radius:9px; padding:3px 8px; font-size:10px; font-weight:600;")
        .arg(c.red()).arg(c.green()).arg(c.blue()).arg(c.name());
}

HealthGraphWidget::HealthGraphWidget(QWidget *parent)
    : QWidget(parent)
    , m_nam(new QNetworkAccessManager(this))
    , m_timer(new QTimer(this))
{
    auto *ly = new QVBoxLayout(this);
    ly->setContentsMargins(8, 8, 8, 8);
    ly->setSpacing(6);

    // Dropdown: "SlimCast (OBS → GPU)" + per-platform entries added by setActivePlatforms
    m_selector = new QComboBox(this);
    m_selector->addItem(QStringLiteral("→ SlimCast"), QString(""));
    m_selector->setStyleSheet(
        "QComboBox { background: #1e2535; color: #94a3b8; border: 1px solid #2d3a50;"
        " border-radius: 6px; padding: 3px 8px; font-size: 11px; }"
        "QComboBox::drop-down { border: none; }"
        "QComboBox QAbstractItemView { background: #1e2535; color: #94a3b8;"
        " border: 1px solid #2d3a50; selection-background-color: #2d3a50; }");
    ly->addWidget(m_selector);

    m_canvas = new GraphCanvas(this);
    ly->addWidget(m_canvas, 1);

    auto *chipsRow = new QWidget;
    m_chipsLayout  = new QHBoxLayout(chipsRow);
    m_chipsLayout->setContentsMargins(0, 0, 0, 0);
    m_chipsLayout->setSpacing(6);
    m_chipsLayout->addStretch();
    ly->addWidget(chipsRow);

    connect(m_selector, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &HealthGraphWidget::onSelectorChanged);

    m_timer->setInterval(5000);
    connect(m_timer, &QTimer::timeout, this, &HealthGraphWidget::onTimer);
    m_timer->start();

    pushToCanvas();
}

void HealthGraphWidget::setApiKey(const QString &key)
{
    m_apiKey = key.trimmed();
}

void HealthGraphWidget::setStreaming(bool streaming)
{
    if (m_streaming == streaming) return;
    m_streaming = streaming;
    if (!streaming)
        m_points.clear();
    pushToCanvas();
}

void HealthGraphWidget::setActivePlatforms(const QStringList &platforms)
{
    if (m_platforms == platforms) return;
    m_platforms = platforms;
    rebuildSelector();
}

void HealthGraphWidget::setBridgeAvailable(bool available)
{
    if (m_bridgeAvailable == available) return;
    m_bridgeAvailable = available;
    rebuildSelector();
}

// Rebuilds the selector to: SlimCast (index 0, fixed) + GPU bridge (if available) + one
// entry per active platform — preserving the current selection across rebuilds.
void HealthGraphWidget::rebuildSelector()
{
    const QString prevKey = m_selectedKey;

    m_selector->blockSignals(true);
    // Always keep index 0 (SlimCast); rebuild everything after it
    while (m_selector->count() > 1)
        m_selector->removeItem(1);
    if (m_bridgeAvailable)
        m_selector->addItem(QStringLiteral("→ GPU bridge"), QStringLiteral("__bridge__"));
    for (const QString &plat : m_platforms) {
        const QString label = QStringLiteral("→ ") + plat[0].toUpper() + plat.mid(1);
        m_selector->addItem(label, plat);
    }
    // Restore prior selection if still present, else fall back to SlimCast
    int restoreIdx = 0;
    for (int i = 0; i < m_selector->count(); ++i) {
        if (m_selector->itemData(i).toString() == prevKey) {
            restoreIdx = i;
            break;
        }
    }
    m_selector->setCurrentIndex(restoreIdx);
    m_selectedKey = m_selector->itemData(restoreIdx).toString();
    m_selector->blockSignals(false);
}

void HealthGraphWidget::onSelectorChanged(int index)
{
    m_selectedKey = m_selector->itemData(index).toString();
    m_points.clear();
    pushToCanvas();
    if (m_streaming && !m_apiKey.isEmpty())
        fetchMetrics();
}

void HealthGraphWidget::fetchMetrics()
{
    QString urlStr = BASE_URL + QStringLiteral("/api/metrics/connection?window=10");
    if (m_selectedKey.isEmpty())
        urlStr += QStringLiteral("&direction=inbound");
    else if (m_selectedKey == QStringLiteral("__bridge__"))
        urlStr += QStringLiteral("&direction=bridge");
    else
        urlStr += QStringLiteral("&direction=outbound&platform=") + m_selectedKey;

    QUrl url(urlStr);
    QNetworkRequest req(url);
    req.setRawHeader("Authorization", ("Bearer " + m_apiKey).toUtf8());
    req.setTransferTimeout(8000);

    QNetworkReply *reply = m_nam->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) return;

        const auto doc = QJsonDocument::fromJson(reply->readAll());
        if (!doc.isObject()) return;

        QList<DataPoint> fresh;
        for (const QJsonValue &v : doc.object()["points"].toArray()) {
            const auto obj = v.toObject();
            DataPoint dp;
            dp.bitrateKbps   = obj["bitrate_kbps"].toDouble();
            dp.healthScore   = obj["health_score"].toDouble();
            dp.droppedFrames = obj["dropped_frames"].toInt();
            fresh.append(dp);
        }
        m_points = fresh;
        pushToCanvas();
    });
}

void HealthGraphWidget::onTimer()
{
    if (m_streaming && !m_apiKey.isEmpty())
        fetchMetrics();
}

void HealthGraphWidget::pushToCanvas()
{
    QList<double> bitrates;
    double currentHealth = -1.0;
    for (const DataPoint &pt : m_points)
        bitrates.append(pt.bitrateKbps);
    if (!m_points.isEmpty())
        currentHealth = m_points.last().healthScore;

    m_canvas->setData(m_streaming, bitrates, currentHealth);
    updateChips();
}

void HealthGraphWidget::updateChips()
{
    while (m_chipsLayout->count() > 1)
        delete m_chipsLayout->takeAt(0)->widget();

    if (!m_streaming || m_points.isEmpty()) return;

    const DataPoint &last = m_points.last();
    const QColor c = healthColor(last.healthScore);

    QString text = QString("%1  %2 kbps  %3%")
        .arg(m_selector->currentText())
        .arg(int(last.bitrateKbps))
        .arg(int(last.healthScore));
    if (last.droppedFrames > 0)
        text += QString("  (%1 dropped)").arg(last.droppedFrames);

    auto *chip = new QLabel(text);
    chip->setStyleSheet(chipStyle(c));
    m_chipsLayout->insertWidget(0, chip);
}
