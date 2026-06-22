#include <obs-module.h>
#include <obs-frontend-api.h>
#include <QMainWindow>
#include <QCoreApplication>
#include <QDir>
#include <dlfcn.h>
#include "relay-dock.hpp"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("slimcast-obs", "en-US")

MODULE_EXPORT const char *obs_module_description(void)
{
    return "SlimCast — stream everywhere from OBS, automatically";
}

static RelayDock *s_dock = nullptr;

static void frontendEventCb(obs_frontend_event event, void *data)
{
    auto *dock = static_cast<RelayDock *>(data);
    // QueuedConnection: keeps the HTTP call off OBS's event dispatch thread.
    switch (event) {
    case OBS_FRONTEND_EVENT_STREAMING_STARTING:
        QMetaObject::invokeMethod(dock, "onObsStreamingStarting",
                                  Qt::QueuedConnection);
        break;
    case OBS_FRONTEND_EVENT_STREAMING_STOPPED:
        QMetaObject::invokeMethod(dock, "onObsStreamingStopped",
                                  Qt::QueuedConnection);
        break;
    default:
        break;
    }
}

// OBS ships QtNetwork but no Qt TLS backend plugin, so https requests fail with
// "TLS initialization failed". We bundle the backend at Contents/PlugIns/tls/
// (see CMakeLists) and add that dir to Qt's plugin search path here, before any
// network call. Path is derived from this module's own location so it works for
// both a local install and a packaged .pkg.
static void registerBundledTlsBackend()
{
    Dl_info info;
    if (!dladdr(reinterpret_cast<const void *>(&registerBundledTlsBackend), &info) || !info.dli_fname)
        return;
    QDir dir(QString::fromUtf8(info.dli_fname));  // …/Contents/MacOS/slimcast-obs
    dir.cdUp();   // MacOS
    dir.cdUp();   // Contents
    QCoreApplication::addLibraryPath(dir.absoluteFilePath("PlugIns"));
}

bool obs_module_load(void)
{
    registerBundledTlsBackend();

    auto *win = static_cast<QMainWindow *>(obs_frontend_get_main_window());
    s_dock = new RelayDock(win);

    obs_frontend_add_dock_by_id(
        "slimcast-dock",
        "SlimCast",
        s_dock->widget()
    );

    obs_frontend_add_event_callback(frontendEventCb, s_dock);
    return true;
}

void obs_module_unload(void)
{
    if (s_dock) {
        obs_frontend_remove_event_callback(frontendEventCb, s_dock);
        s_dock = nullptr;
    }
}
