# syntax=docker/dockerfile:1
# Microsoft SQL MCP Server (Data API builder) — standalone sidecar image.
# Serves MCP over streamable HTTP at :5000/mcp; config bind-mounted at /etc/dab.

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
RUN dotnet tool install Microsoft.DataApiBuilder --tool-path /opt/dab

FROM mcr.microsoft.com/dotnet/aspnet:8.0
COPY --from=build /opt/dab /opt/dab
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    PATH=/opt/dab:$PATH

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s \
  CMD ["dab", "validate", "--config", "/etc/dab/dab-config.json"]

CMD ["dab", "start", "--config", "/etc/dab/dab-config.json", "--no-https-redirect"]
