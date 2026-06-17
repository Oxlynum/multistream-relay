cmake_minimum_required(VERSION 3.26)
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/common/bootstrap.cmake" NO_POLICY_SCOPE)

project(obs-relay-control VERSION 1.0.0 LANGUAGES CXX)

# Download obs-deps Qt and create OBS IMPORTED targets.
# Must be after project() so CMAKE_SYSTEM_NAME / APPLE / WIN32 are known.
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

# ── Plugin target ─────────────────────────────────────────────────────────────
add_library(obs-relay-control MODULE
    src/plugin-main.cpp
    src/relay-api.cpp
    src/relay-dock.cpp
    src/cloud-provider.cpp
)

set_target_properties(obs-relay-control PROPERTIES
    AUTOMOC ON
    PREFIX  ""
    FOLDER  "plugins"
)

if(APPLE)
    set_target_properties(obs-relay-control PROPERTIES SUFFIX ".so")
endif()

target_include_directories(obs-relay-control PRIVATE src)

target_compile_definitions(obs-relay-control PRIVATE
    PLUGIN_VERSION="${PROJECT_VERSION}"
)

target_link_libraries(obs-relay-control PRIVATE
    OBS::libobs
    OBS::obs-frontend-api
    Qt6::Core
    Qt6::Gui
    Qt6::Widgets
    Qt6::Network
)

# ── Install ───────────────────────────────────────────────────────────────────
# macOS: install into .plugin bundle structure so OBS can load it.
#   cmake --install build/macos-arm64 \
#     --prefix "$HOME/Library/Application Support/obs-studio/plugins"
#   → creates obs-relay-control.plugin/Contents/MacOS/obs-relay-control
#
# Windows: standard OBS plugin layout under the OBS install root.
if(APPLE)
    install(
        PROGRAMS "$<TARGET_FILE:obs-relay-control>"
        DESTINATION "obs-relay-control.plugin/Contents/MacOS"
        RENAME "obs-relay-control"
    )
    install(
        FILES "${CMAKE_CURRENT_SOURCE_DIR}/cmake/macos/Info.plist"
        DESTINATION "obs-relay-control.plugin/Contents"
    )
    install(
        DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/data/"
        DESTINATION "obs-relay-control.plugin/Contents/Resources"
    )
elseif(WIN32)
    install(TARGETS obs-relay-control
        RUNTIME DESTINATION "obs-plugins/64bit"
    )
    install(
        DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/data/"
        DESTINATION "data/obs-plugins/obs-relay-control"
    )
endif()
