#cloud-config
hostname: oci-harness

users:
  - name: deploy
    groups: [docker, sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ${ssh_public_key}

package_update: true
package_upgrade: false

packages:
  - curl
  - ca-certificates
  - gnupg

runcmd:
  # Docker
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker

  # Tailscale
  - curl -fsSL https://tailscale.com/install.sh | sh
  - tailscale up --authkey="${tailscale_auth_key}" --hostname=oci-harness --accept-routes

  # App directory
  - mkdir -p /opt/harness
  - chown deploy:deploy /opt/harness
