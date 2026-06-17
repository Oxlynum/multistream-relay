# cmake/common/bootstrap.cmake
# Entry point included by CMakeLists.txt BEFORE project().
# Sets up module paths and triggers platform dependency downloads.

include_guard(GLOBAL)

cmake_minimum_required(VERSION 3.26)

# Map optimised build-type configs for IMPORTED targets so that RelWithDebInfo
# finds release-mode Qt/OBS libraries even if they only ship a Release config.
set(CMAKE_MAP_IMPORTED_CONFIG_RELWITHDEBINFO RelWithDebInfo Release MinSizeRel None "")
set(CMAKE_MAP_IMPORTED_CONFIG_RELEASE        Release RelWithDebInfo MinSizeRel None "")
set(CMAKE_MAP_IMPORTED_CONFIG_MINSIZEREL     MinSizeRel Release RelWithDebInfo None "")

# Make find_package targets globally visible without explicit GLOBAL keyword
set(CMAKE_FIND_PACKAGE_TARGETS_GLOBAL TRUE)

# Add our cmake module directories to the search path
list(APPEND CMAKE_MODULE_PATH
    "${CMAKE_CURRENT_SOURCE_DIR}/cmake/common"
    "${CMAKE_CURRENT_SOURCE_DIR}/cmake/macos"
    "${CMAKE_CURRENT_SOURCE_DIR}/cmake/windows"
)

# Platform buildspecs (dep downloads + IMPORTED targets) are included from
# CMakeLists.txt AFTER project() — CMAKE_SYSTEM_NAME is not set yet here.
