# cmake/windows/buildspec.cmake
# Windows build setup:
#   1. Downloads obs-deps Qt 6.8.x into .deps/
#   2. Finds OBS SDK (installed OBS or OBS_SDK_PATH env/cache variable)

include_guard(GLOBAL)
include(buildspec_common)

function(_check_dependencies_plugin_windows)
    set(arch x64)
    set(platform windows-${arch})
    set(dependencies_dir "${CMAKE_CURRENT_SOURCE_DIR}/.deps")

    set(qt6_filename    "windows-deps-qt6-VERSION-ARCH-REVISION.zip")
    set(qt6_destination "obs-deps-qt6-VERSION-ARCH")

    set(dependencies_list qt6)
    _check_dependencies(${dependencies_list})
endfunction()

_check_dependencies_plugin_windows()

# ── OBS SDK ───────────────────────────────────────────────────────────────────
# OBS installs cmake configs to <install_root>/cmake/ on Windows.
if(DEFINED ENV{OBS_SDK_PATH})
    list(APPEND CMAKE_PREFIX_PATH "$ENV{OBS_SDK_PATH}")
elseif(DEFINED OBS_SDK_PATH)
    list(APPEND CMAKE_PREFIX_PATH "${OBS_SDK_PATH}")
else()
    list(APPEND CMAKE_PREFIX_PATH "C:/Program Files/obs-studio")
endif()
set(CMAKE_PREFIX_PATH "${CMAKE_PREFIX_PATH}" CACHE PATH "" FORCE)

message(STATUS "Windows build configured: Qt from obs-deps, OBS SDK from CMAKE_PREFIX_PATH")
