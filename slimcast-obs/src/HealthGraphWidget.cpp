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

static QColor colorForKey(const QString &key)
{
    if (key.isEmpty())     return QColor(0xff, 0xff, 0xff);  // white  — ingest
    if (key == "twitch")   return QColor(0x9b, 0x59, 0xf5);  // purple
    if (key == "youtube")  return QColor(0xff, 0x33, 0x33);  // red
    if (key == "facebook") return QColor(0x4d, 0x8e, 0xf0);  // blue
    if (key == "kick")     return QColor(0x37, 0xd6, 0x7a);  // green
    if (key == "tiktok")   return QColor(0xff, 0x69, 0xb4);  // pink
    return QColor(0x8a, 0x93, 0xa3);
}

// ── GraphCanvas ───────────────────────────────────────────────────────────────

class GraphCanvas : public QWidget {
    Q_OBJECT
public:
    struct Line {
        QColor        color;
        QList<double> bitrate;
    };

    explicit GraphCanvas(QWidget *parent = nullptr) : QWidget(parent)
    {
        setMinimumHeight(180);
        setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
        setAutoFillBackground(false);
    }

    void setData(bool streaming, const QList<Line> &lines)
    {
        m_streaming = streaming;
        m_lines     = lines;
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRect r = rect().adjusted(6, 6, -6, -6);
        p.fillRect(rect(), QColor(0x0f, 0x13, 0x1c));

        if (!m_streaming) {
            p.setPen(QColor(0x6b, 0x72, 0x80));
            QFont f = font();
            f.setPointSize(10);
            p.setFont(f);
            p.drawText(r, Qt::AlignCenter | Qt::TextWordWrap,
                       "Start streaming to see connection health");
            return;
        }

        // Shared y-scale: max bitrate across all lines
        double mx = 1.0;
        for (const Line &l : m_lines)
            for (double v : l.bitrate)
                if (v > mx) mx = v;
        mx *= 1.08;

        // Vertical separator at 1/3 — the relay node in the pipeline
        const int sepX  = r.left() + r.width() / 3;
        const int nodeY = r.top()  + r.height() / 2;

        QPen sepPen(QColor(0x55, 0x60, 0x70, 160));
        sepPen.setWidthF(1.0);
        sepPen.setStyle(Qt::DashLine);
        p.setPen(sepPen);
        p.drawLine(sepX, r.top(), sepX, r.bottom());

        p.setPen(Qt::NoPen);
        p.setBrush(QColor(0x55, 0x60, 0x70, 200));
        p.drawEllipse(QPoint(sepX, nodeY), 5, 5);

        // All bitrate lines on the same scale
        for (const Line &l : m_lines) {
            if (l.bitrate.size() < 2) continue;
            drawLine(p, r, l.bitrate, l.color, mx);
        }
    }

private:
    void drawLine(QPainter &p, const QRect &r,
                  const QList<double> &data, const QColor &color, double mx)
    {
        const int    n     = data.size();
        const double xStep = double(r.width()) / double(n - 1);

        QPolygon poly;
        for (int i = 0; i < n; ++i) {
            const int x = r.left() + int(i * xStep + 0.5);
            const int y = r.bottom() - int(data[i] / mx * r.height() + 0.5);
            poly << QPoint(x, std::clamp(y, r.top(), r.bottom()));
        }

        QPen pen(color);
        pen.setWidthF(1.6);
        p.setPen(pen);
        p.drawPolyline(poly);
    }

    bool        m_streaming = false;
    QList<Line> m_lines;
};

#include "HealthGraphWidget.moc"

// ── HealthGraphWidget ─────────────────────────────────────────────────────────

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

    m_canvas = new GraphCanvas(this);
    ly->addWidget(m_canvas, 1);

    auto *chipsRow = new QWidget;
    m_chipsLayout  = new QHBoxLayout(chipsRow);
    m_chipsLayout->setContentsMargins(0, 0, 0, 0);
    m_chipsLayout->setSpacing(6);
    m_chipsLayout->addStretch();
    ly->addWidget(chipsRow);

    m_timer->setInterval(5000);
    connect(m_timer, &QTimer::timeout, this, &HealthGraphWidget::onTimer);
    m_timer->start();

    rebuildSources();
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
        for (Source &s : m_sources) s.pts.clear();
    pushToCanvas();
}

void HealthGraphWidget::setActivePlatforms(const QStringList &platforms)
{
    if (m_platforms == platforms) return;
    m_platforms = platforms;
    rebuildSources();
}

void HealthGraphWidget::rebuildSources()
{
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
    pushToCanvas();
}

void HealthGraphWidget::updateChips()
{
    // Remove all chips (everything except the trailing stretch)
    while (m_chipsLayout->count() > 1)
        delete m_chipsLayout->takeAt(0)->widget();

    if (!m_streaming) return;

    for (const Source &s : m_sources) {
        if (s.pts.isEmpty()) continue;
        const QColor c = colorForKey(s.key);
        auto *chip = new QLabel(
            QString("%1  %2 kbps").arg(s.label).arg(int(s.pts.last().bitrateKbps)));
        chip->setStyleSheet(chipStyle(c));
        m_chipsLayout->insertWidget(m_chipsLayout->count() - 1, chip);
    }
}

void HealthGraphWidget::pushToCanvas()
{
    QList<GraphCanvas::Line> lines;
    for (const Source &s : m_sources) {
        if (s.pts.isEmpty()) continue;
        GraphCanvas::Line l;
        l.color = colorForKey(s.key);
        for (const DataPoint &pt : s.pts)
            l.bitrate.append(pt.bitrateKbps);
        lines.append(l);
    }
    m_canvas->setData(m_streaming, lines);
    updateChips();
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
            const auto o   = v.toObject();
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
