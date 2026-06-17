#include <obs-module.h>
#include <obs-frontend-api.h>
#include <QMainWindow>
#include "relay-dock.hpp"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("obs-relay-control", "en-US")

MODULE_EXPORT const char *obs_module_description(void)
{
    return "Relay Control — manage HEVC cloud transcoding multistreamer servers";
}

static RelayDock *s_dock = nullptr;

static void frontendEventCb(obs_frontend_event event, void *data)
{
    auto *dock = static_cast<RelayDock *>(data);
    // Use QueuedConnection so the HTTP POST runs on the Qt event loop, not
    // inside OBS's frontend event dispatch (which expects a fast return).
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

bool obs_module_load(void)
{
    auto *win = static_cast<QMainWindow *>(obs_frontend_get_main_window());
    s_dock = new RelayDock(win);

    // obs_frontend_add_dock (the old QDockWidget overload) was removed in OBS 30.
    // obs_frontend_add_dock_by_id takes a QWidget* and wraps it in a new dock.
    // obs_frontend_add_custom_qdock takes an existing QDockWidget* directly.
    obs_frontend_add_dock_by_id(
        "obs-relay-control-dock",
        obs_module_text("RelayControlDock"),
        s_dock->widget()   // the inner QWidget content, not the dock itself
    );

    obs_frontend_add_event_callback(frontendEventCb, s_dock);
    return true;
}

void obs_module_unload(void)
{
    if (s_dock) {
        obs_frontend_remove_event_callback(frontendEventCb, s_dock);
        // OBS owns and destroys dock widgets registered via obs_frontend_add_dock_by_id.
        s_dock = nullptr;
    }
}
