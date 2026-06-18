#pragma once
#include <QString>
#include <QList>

struct ProviderPreset {
    QString name;
    QString protocol;          // "rtmp" | "srt"
    int     defaultIngestPort; // port OBS streams to
    int     defaultApiPort;    // relay control-panel port (almost always 8080)
    QString ingestUrlTemplate; // {host} and {port} are substituted at runtime
    QString note;              // shown as a tooltip in the UI
};

inline const QList<ProviderPreset> &providerPresets()
{
    // SRT (UDP) providers give the best quality on marginal uplinks. RunPod is
    // TCP-only so it must use enhanced-RTMP; all other major GPU clouds support UDP.
    static const QList<ProviderPreset> presets = {
        {
            "RunPod",
            "rtmp",
            1935,
            8080,
            "rtmp://{host}:{port}/live",
            "TCP only. Use the mapped external TCP port shown in RunPod's Connect tab.\n"
            "On Community Cloud the IP can change on restart; use Secure Cloud for a stable IP."
        },
        {
            "Vultr",
            "srt",
            8890,
            8080,
            "srt://{host}:{port}",
            "UDP/SRT supported. Best for low-upload streamers — loss-resilient transport.\n"
            "Open UDP port 8890 in your Vultr Firewall Group before connecting."
        },
        {
            "DigitalOcean",
            "srt",
            8890,
            8080,
            "srt://{host}:{port}",
            "UDP/SRT supported. Open ingest port in the Droplet's firewall rules."
        },
        {
            "Paperspace",
            "srt",
            8890,
            8080,
            "srt://{host}:{port}",
            "UDP/SRT supported. Use the machine's Public IP. Open UDP 8890 in the firewall."
        },
        {
            "Hetzner",
            "srt",
            8890,
            8080,
            "srt://{host}:{port}",
            "UDP/SRT supported. European GPU server options; good if your latency to EU is low."
        },
        {
            "AWS EC2",
            "srt",
            8890,
            8080,
            "srt://{host}:{port}",
            "UDP/SRT supported. Add an inbound UDP rule for port 8890 in your Security Group."
        },
        {
            "Lambda Labs",
            "srt",
            8890,
            8080,
            "srt://{host}:{port}",
            "UDP/SRT supported. Competitive GPU rates; good A10/A100 availability."
        },
        {
            "CoreWeave",
            "srt",
            8890,
            8080,
            "srt://{host}:{port}",
            "UDP/SRT supported. L40 / A100 instances available; strong datacenter bandwidth."
        },
        {
            "Custom",
            "rtmp",
            1935,
            8080,
            "rtmp://{host}:{port}/live",
            "Enter your own server address, ports, and select the right protocol below."
        },
    };
    return presets;
}
