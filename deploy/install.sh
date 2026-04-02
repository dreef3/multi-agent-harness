#!/usr/bin/env bash
# First-time installation script for RHEL 8+ VM deployment.
# Run as root.
set -euo pipefail

INSTALL_DIR=/opt/multi-agent-harness

echo "==> Creating install directory"
mkdir -p "$INSTALL_DIR"

echo "==> Copying compose files"
cp docker-compose.yml "$INSTALL_DIR/"
cp docker-compose.corp.yaml "$INSTALL_DIR/"

echo "==> Copying .env (edit $INSTALL_DIR/.env after installation)"
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp .env.example "$INSTALL_DIR/.env"
  echo "    IMPORTANT: Edit $INSTALL_DIR/.env before starting the service"
fi

echo "==> Installing systemd unit"
cp deploy/harness.service /etc/systemd/system/harness.service

echo "==> Reloading systemd"
systemctl daemon-reload

echo "==> Enabling harness service (start on boot)"
systemctl enable harness

echo ""
echo "Installation complete."
echo "Edit $INSTALL_DIR/.env, then run: systemctl start harness"
echo "View logs with: journalctl -u harness -f"
