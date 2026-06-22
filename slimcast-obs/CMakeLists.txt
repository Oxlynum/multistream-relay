cmake_minimum_required(VERSION 3.26)
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/common/bootstrap.cmake" NO_POLICY_SCOPE)

project(slimcast-obs VERSION 2.3.1 LANGUAGES CXX)

if(APPLE)
    include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/macos/buildspec.cmake")
elseif(WIN32)
    include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/windows/buildspec.cmake")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_INCLUDE_CURRENT_DIR TRUE)

# ── Qt ────────────────────────────────────────────────────────────────────────
find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets Network)

# OBS bundles QtNetwork but ships NO Qt TLS backend plugin, so any https request
# from a plugin dies with "TLS initialization failed". We bundle Qt's TLS
# backend(s) into our own plugin and point Qt at them at load time. Locate the
# backend dir relative to the Qt6 cmake package.
get_filename_component(_QT_ROOT "${Qt6_DIR}/../../.." ABSOLUTE)
set(SLIMCAST_QT_TLS_DIR "${_QT_ROOT}/plugins/tls")

# ── Plugin target ─────────────────────────────────────────────────────────────
add_library(slimcast-obs MODULE
    src/plugin-main.cpp
    src/relay-api.cpp
    src/relay-dock.cpp
)

set_target_properties(slimcast-obs PROPERTIES
    AUTOMOC ON
    PREFIX  ""
    FOLDER  "plugins"
)

if(APPLE)
    set_target_properties(slimcast-obs PROPERTIES SUFFIX ".so")
endif()

target_include_directories(slimcast-obs PRIVATE src)

target_compile_definitions(slimcast-obs PRIVATE
    PLUGIN_VERSION="${PROJECT_VERSION}"
)

target_link_libraries(slimcast-obs PRIVATE
    OBS::libobs
    OBS::obs-frontend-api
    Qt6::Core
    Qt6::Gui
    Qt6::Widgets
    Qt6::Network
)

# ── Install ───────────────────────────────────────────────────────────────────
if(APPLE)
    install(
        PROGRAMS "$<TARGET_FILE:slimcast-obs>"
        DESTINATION "slimcast-obs.plugin/Contents/MacOS"
        RENAME "slimcast-obs"
    )
    install(
        FILES "${CMAKE_CURRENT_SOURCE_DIR}/cmake/macos/Info.plist"
        DESTINATION "slimcast-obs.plugin/Contents"
    )
    install(
        DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/data/"
        DESTINATION "slimcast-obs.plugin/Contents/Resources"
    )
    # Bundle Qt's TLS backend so QNetworkAccessManager can do https (see above).
    if(EXISTS "${SLIMCAST_QT_TLS_DIR}")
        install(
            DIRECTORY "${SLIMCAST_QT_TLS_DIR}/"
            DESTINATION "slimcast-obs.plugin/Contents/PlugIns/tls"
        )
    else()
        message(WARNING "Qt TLS backend dir not found at ${SLIMCAST_QT_TLS_DIR} — https will fail")
    endif()
elseif(WIN32)
    install(TARGETS slimcast-obs
        RUNTIME DESTINATION "obs-plugins/64bit"
    )
    install(
        DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/data/"
        DESTINATION "data/obs-plugins/slimcast-obs"
    )
endif()
