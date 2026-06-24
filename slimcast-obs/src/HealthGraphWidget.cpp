#include "HealthGraphWidget.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
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
// Internal painting widget. Receives parallel value arrays and renders two
// auto-scaled sparklines — blue for bitrate, green for health score.

class GraphCanvas : public QWidget {
    Q_OBJECT
public:
    explicit GraphCanvas(QWidget *parent = nullptr) : QWidget(parent)
    {
        setMinimumHeight(200);
        setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
        setAutoFillBackground(false);
    }

    void setData(bool streaming,
                 const QList<double> &bitrate,
                 const QList<double> &health)
    {
        m_streaming = streaming;
        m_bitrate   = bitrate;
        m_health    = health;
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRect r = rect().adjusted(6, 6, -6, -6);
        p.fillRect(rect(), QColor(0x0f, 0x13, 0x1c));

        if (!m_streaming || m_bitrate.isEmpty()) {
            p.setPen(QColor(0x6b, 0x72, 0x80));
            QFont f = font();
            f.setPointSize(10);
            p.setFont(f);
            p.drawText(r, Qt::AlignCenter | Qt::TextWordWrap,
                       "Start streaming to see connection health");
            return;
        }

        drawLine(p, r, m_bitrate, QColor(0x4d, 0x8e, 0xf0));   // blue — bitrate
        drawLine(p, r, m_health,  QColor(0x37, 0xd6, 0x7a));   // green — health
    }

private:
    void drawLine(QPainter &p, const QRect &r,
                  const QList<double> &data, const QColor &color)
    {
        if (data.size() < 2) return;

        double mn = *std::min_element(data.begin(), data.end());
        double mx = *std::max_element(data.begin(), data.end());
        if (mx - mn < 1e-9) { mn -= 1; mx += 1; }

        const double pad = (mx - mn) * 0.05 + 0.5;
        mn -= pad; mx += pad;

        const int n = data.size();
        const double xStep  = double(r.width()) / double(n - 1);
        const double yRange = mx - mn;

        QPolygon poly;
        for (int i = 0; i < n; ++i) {
            const int x = r.left() + int(i * xStep + 0.5);
            const int y = r.bottom() - int((data[i] - mn) / yRange * r.height() + 0.5);
            poly << QPoint(x, std::clamp(y, r.top(), r.bottom()));
        }

        QPen pen(color);
        pen.setWidthF(1.6);
        p.setPen(pen);
        p.drawPolyline(poly);
    }

    bool          m_streaming = false;
    QList<double> m_bitrate;
    QList<double> m_health;
};

#include "HealthGraphWidget.moc"

// ── HealthGraphWidget ─────────────────────────────────────────────────────────

static QString chipStyle(const QString &bg, const QString &fg)
{
    return QString(
        "background:%1; color:%2; border-radius:9px; padding:3px 10px;"
        " font-size:11px; font-weight:600;").arg(bg, fg);
}

HealthGraphWidget::HealthGraphWidget(QWidget *parent)
    : QWidget(parent)
    , m_nam(new QNetworkAccessManager(this))
    , m_timer(new QTimer(this))
{
    auto *ly = new QVBoxLayout(this);
    ly->setContentsMargins(8, 8, 8, 8);
    ly->setSpacing(6);

    m_combo = new QComboBox;
    m_combo->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Fixed);
    m_combo->setStyleSheet(
        "QComboBox{background:#1a1f2b; color:#cbd2dd; border:1px solid #2a313d;"
        " border-radius:5px; padding:4px 8px;}"
        "QComboBox::drop-down{border:none;}"
        "QComboBox QAbstractItemView{background:#1a1f2b; color:#cbd2dd;"
        " selection-background-color:#2a313d;}");
    ly->addWidget(m_combo);

    m_canvas = new GraphCanvas(this);
    ly->addWidget(m_canvas, 1);

    // Stat chips — live values below the graph.
    auto *chips = new QHBoxLayout;
    chips->setSpacing(8);
    m_bitrateChip = new QLabel("—");
    m_bitrateChip->setStyleSheet(chipStyle("#162033", "#4d8ef0"));
    m_healthChip  = new QLabel("—");
    m_healthChip->setStyleSheet(chipStyle("#0d2419", "#37d67a"));
    chips->addWidget(m_bitrateChip);
    chips->addWidget(m_healthChip);
    chips->addStretch();
    ly->addLayout(chips);

    connect(m_combo, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, [this](int idx) {
                m_selected = (idx >= 0) ? idx : 0;
                pushToCanvas();
            });

    m_timer->setInterval(5000);
    connect(m_timer, &QTimer::timeout, this, &HealthGraphWidget::onTimer);
    m_timer->start();

    rebuildCombo();
}

void HealthGraphWidget::setApiKey(const QString &key)
{
    m_apiKey = key.trimmed();
}

void HealthGraphWidget::setStreaming(bool streaming)
{
    if (m_streaming == streaming) return;
    m_streaming = streaming;
    if (!streaming) {
        for (Source &s : m_sources) s.pts.clear();
        m_bitrateChip->setText("—");
        m_healthChip->setText("—");
    }
    pushToCanvas();
}

void HealthGraphWidget::setActivePlatforms(const QStringList &platforms)
{
    if (m_platforms == platforms) return;
    m_platforms = platforms;
    rebuildCombo();
}

void HealthGraphWidget::rebuildCombo()
{
    const QString prevLabel = m_combo->currentText();

    QList<Source> fresh;
    {
        Source s;
        s.label = "OBS → SlimCast";
        s.key   = "";
        for (const Source &old : m_sources)
            if (old.key == s.key) { s.pts = old.pts; break; }
        fresh.append(s);
    }
    for (const QString &plat : m_platforms) {
        Source s;
        s.label = QStringLiteral("→ ") + plat[0].toUpper() + plat.mid(1);
        s.key   = plat;
        for (const Source &old : m_sources)
            if (old.key == s.key) { s.pts = old.pts; break; }
        fresh.append(s);
    }
    m_sources = fresh;

    m_combo->blockSignals(true);
    m_combo->clear();
    for (const Source &s : m_sources)
        m_combo->addItem(s.label);
    const int idx = m_combo->findText(prevLabel);
    m_selected = (idx >= 0) ? idx : 0;
    m_combo->setCurrentIndex(m_selected);
    m_combo->blockSignals(false);

    pushToCanvas();
}

void HealthGraphWidget::pushToCanvas()
{
    QList<double> bitrate, health;
    if (m_selected >= 0 && m_selected < m_sources.size()) {
        for (const DataPoint &pt : m_sources[m_selected].pts) {
            bitrate.append(pt.bitrateKbps);
            health.append(pt.healthScore);
        }
    }
    m_canvas->setData(m_streaming, bitrate, health);

    // Update chips from the latest point.
    if (!bitrate.isEmpty() && m_streaming) {
        m_bitrateChip->setText(
            QString("%1 kbps").arg(int(bitrate.last())));
        const int h = int(health.last());
        const QString hColor = h >= 80 ? "#37d67a" : (h >= 50 ? "#ffb020" : "#ff5470");
        const QString hBg    = h >= 80 ? "#0d2419"  : (h >= 50 ? "#2a1e06"  : "#2a0a0f");
        m_healthChip->setStyleSheet(chipStyle(hBg, hColor));
        m_healthChip->setText(QString("Health %1%").arg(h));
    } else if (!m_streaming) {
        m_bitrateChip->setText("—");
        m_healthChip->setText("—");
        m_bitrateChip->setStyleSheet(chipStyle("#162033", "#4d8ef0"));
        m_healthChip->setStyleSheet(chipStyle("#0d2419", "#37d67a"));
    }
}

void HealthGraphWidget::onTimer()
{
    if (m_streaming && !m_apiKey.isEmpty())
        fetchMetrics();
}

void HealthGraphWidget::fetchMetrics()
{
    QNetworkRequest req(QUrl(BASE_URL + "/api/metrics/connection"));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    req.setRawHeader("Authorization", ("Bearer " + m_apiKey).toUtf8());
    req.setTransferTimeout(8000);

    QNetworkReply *reply = m_nam->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) return;

        const auto doc = QJsonDocument::fromJson(reply->readAll());
        if (!doc.isObject()) return;
        const auto obj = doc.object();

        if (!m_sources.isEmpty()) {
            DataPoint dp;
            dp.bitrateKbps = obj["ingest_kbps"].toDouble();
            dp.healthScore  = obj["health_score"].toDouble();
            auto &pts = m_sources[0].pts;
            pts.append(dp);
            if (pts.size() > MAX_POINTS) pts.removeFirst();
        }

        for (const QJsonValue &v : obj["outputs"].toArray()) {
            const auto o = v.toObject();
            const QString key = o["platform"].toString();
            for (int i = 1; i < m_sources.size(); ++i) {
                if (m_sources[i].key == key) {
                    DataPoint dp;
                    dp.bitrateKbps = o["outbound_kbps"].toDouble();
                    dp.healthScore  = o["health_score"].toDouble();
                    auto &pts = m_sources[i].pts;
                    pts.append(dp);
                    if (pts.size() > MAX_POINTS) pts.removeFirst();
                    break;
                }
            }
        }

        pushToCanvas();
    });
}
