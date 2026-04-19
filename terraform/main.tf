provider "oci" {
  tenancy_ocid = var.tenancy_ocid
  user_ocid    = var.user_ocid
  fingerprint  = var.fingerprint
  private_key  = var.private_key
  region       = var.region
}

# ── Availability domain ──────────────────────────────────────────────────────

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

locals {
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
}

# ── Ubuntu 22.04 ARM image ───────────────────────────────────────────────────

data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
  state                    = "AVAILABLE"
}

# ── Networking ───────────────────────────────────────────────────────────────

resource "oci_core_vcn" "harness" {
  compartment_id = var.compartment_id
  cidr_block     = "10.0.0.0/16"
  display_name   = "harness-vcn"
  dns_label      = "harness"
}

resource "oci_core_internet_gateway" "harness" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.harness.id
  display_name   = "harness-igw"
  enabled        = true
}

resource "oci_core_route_table" "harness" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.harness.id
  display_name   = "harness-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.harness.id
  }
}

resource "oci_core_security_list" "harness" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.harness.id
  display_name   = "harness-sl"

  # SSH — key-based auth; Tailscale is the primary access path
  ingress_security_rules {
    protocol  = "6" # TCP
    source    = "0.0.0.0/0"
    stateless = false

    tcp_options {
      min = 22
      max = 22
    }
  }

  # ICMP for reachability checks
  ingress_security_rules {
    protocol  = "1" # ICMP
    source    = "0.0.0.0/0"
    stateless = false
  }

  # All outbound (Docker pulls, Tailscale, apt, etc.)
  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
    stateless   = false
  }
}

resource "oci_core_subnet" "harness" {
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.harness.id
  cidr_block        = "10.0.0.0/24"
  display_name      = "harness-subnet"
  dns_label         = "harness"
  route_table_id    = oci_core_route_table.harness.id
  security_list_ids = [oci_core_security_list.harness.id]
}

# ── Compute instance ─────────────────────────────────────────────────────────

resource "oci_core_instance" "harness" {
  compartment_id      = var.compartment_id
  availability_domain = local.availability_domain
  display_name        = "harness"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu_arm.images[0].id
    # 50 GB boot volume — well within Always Free allowance
    boot_volume_size_in_gbs = 50
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.harness.id
    assign_public_ip = true
    display_name     = "harness-vnic"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(templatefile("${path.module}/cloud-init.yml.tpl", {
      ssh_public_key     = var.ssh_public_key
      tailscale_auth_key = var.tailscale_auth_key
    }))
  }

  # Prevent accidental recreation of the VM
  lifecycle {
    ignore_changes = [source_details[0].source_id]
  }
}
