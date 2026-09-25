#!/usr/bin/env bash
# One-time hardening + Docker install for an Oracle Cloud Ampere A1 VM (Ubuntu 24.04, arm64).
# Run as root:  sudo bash infra/oracle/setup-vm.sh
# Also open TCP 80 and 443 in the VCN security list (OCI console → Networking → your VCN →
# Security Lists → Add Ingress Rules, source 0.0.0.0/0). Leave everything else closed.
set -euo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git unattended-upgrades fail2ban netfilter-persistent

# security updates install themselves
dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker Engine + compose plugin (official convenience script; arm64 supported)
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "${SUDO_USER:-ubuntu}"

# OCI's Ubuntu images only allow SSH in iptables; allow HTTP/HTTPS for Caddy (ACME + webhook).
for port in 80 443; do
  iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 6 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
done
netfilter-persistent save

# SSH: keys only (OCI instances are created with your public key)
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd
systemctl enable --now fail2ban

echo "VM ready. Log out and back in (docker group), then: git clone … && cd n8nCRM-automation"
